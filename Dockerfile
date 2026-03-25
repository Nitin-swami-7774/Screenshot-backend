FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
