const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;
// ── CORS ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// ── DEVICE VIEWPORTS ────────────────────────────────────────────────────
const VIEWPORTS = {
  mobile:  { width: 430,  height: 932  },
  tablet:  { width: 912,  height: 1368 },
  desktop: { width: 1280, height: 800  },
};

// ── SCREENSHOT CACHE (in-memory, 5 min TTL) ─────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(url, device) {
  const key = `${device}:${url}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setCache(url, device, buffer) {
  const key = `${device}:${url}`;
  cache.set(key, { buffer, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ── BLOCKED RESOURCE TYPES ──────────────────────────────────────────────
const BLOCKED_TYPES = new Set(['font', 'media', 'websocket']);
const BLOCKED_URL_PATTERNS = [
  'google-analytics.com', 'googletagmanager.com', 'facebook.net',
  'doubleclick.net', 'adservice.google', 'analytics.',
  'hotjar.com', 'mixpanel.com', 'segment.com',
];

// ── PAGE POOL ───────────────────────────────────────────────────────────
let browser = null;
const PAGE_POOL_SIZE = 8;
const pagePool = [];
let poolReady = false;

async function initBrowser() {
  console.log('[init] Launching Chromium...');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run',
      '--single-process',
    ],
  });

  console.log(`[init] Creating page pool (${PAGE_POOL_SIZE} pages)...`);
  for (let i = 0; i < PAGE_POOL_SIZE; i++) {
    const context = await browser.newContext({
      viewport: VIEWPORTS.desktop,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Block heavy / tracking resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_TYPES.has(type)) return route.abort();

      const url = route.request().url();
      if (BLOCKED_URL_PATTERNS.some(p => url.includes(p))) return route.abort();

      return route.continue();
    });

    pagePool.push({ page, context, busy: false });
  }

  poolReady = true;
  console.log('[init] Ready!');
}

async function acquirePage() {
  // Wait for pool
  for (let i = 0; i < 100; i++) {
    const entry = pagePool.find(p => !p.busy);
    if (entry) {
      entry.busy = true;
      return entry;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('No pages available');
}

function releasePage(entry) {
  entry.busy = false;
}

// ── RENDER ENDPOINT ─────────────────────────────────────────────────────
app.get('/api/render', async (req, res) => {
  const { url, device = 'desktop', refresh } = req.query;

  if (!url) return res.status(400).json({ error: 'url parameter required' });
  if (!poolReady) return res.status(503).json({ error: 'Server starting up' });

  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const forceRefresh = refresh === 'true';

  // Check cache (skip if refresh forced)
  if (!forceRefresh) {
    const cached = getCached(url, device);
    if (cached) {
      console.log(`[cache hit] ${device}:${url}`);
      res.set({
        'Content-Type': 'image/jpeg',
        'X-Render-Type': 'playwright-cached',
        'X-Cache': 'HIT',
        'Cache-Control': 'public, max-age=300',
      });
      return res.send(cached);
    }
  }

  let entry;
  try {
    entry = await acquirePage();
    const { page, context } = entry;

    // Set viewport for this request
    await context.setDefaultTimeout(12000);
    await page.setViewportSize(viewport);

    const start = Date.now();

    // Navigate with robust waiting
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

    // Wait for network to settle (best-effort, don't block)
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    // Small render settle for JS-heavy pages
    await page.waitForTimeout(400);

    const renderTime = Date.now() - start;

    // Take clipped screenshot (viewport only, fast)
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 65,
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    });

    // Cache it
    setCache(url, device, buffer);

    console.log(`[render] ${device}:${url} → ${renderTime}ms, ${(buffer.length / 1024).toFixed(0)}KB`);

    res.set({
      'Content-Type': 'image/jpeg',
      'X-Render-Type': 'playwright-live',
      'X-Render-Time': String(renderTime),
      'X-Cache': 'MISS',
      'Cache-Control': forceRefresh ? 'no-store' : 'public, max-age=300',
    });
    res.send(buffer);
  } catch (err) {
    console.error(`[error] ${url}: ${err.message}`);
    res.status(500).json({ error: 'Render failed', detail: err.message });
  } finally {
    if (entry) releasePage(entry);
  }
});

// ── HEALTH CHECK ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const free = pagePool.filter(p => !p.busy).length;
  res.json({
    status: 'ok',
    pool: { total: PAGE_POOL_SIZE, free },
    cache: cache.size,
    uptime: process.uptime(),
  });
});

// ── CACHE CLEAR ─────────────────────────────────────────────────────────
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ status: 'cleared' });
});

// ── START ────────────────────────────────────────────────────────────────
initBrowser()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Screenshot API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init browser:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[shutdown] Closing browser...');
  if (browser) await browser.close();
  process.exit(0);
});
