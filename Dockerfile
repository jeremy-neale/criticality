FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY shared ./shared
COPY server ./server
COPY public ./public
EXPOSE 8080
CMD ["node", "server/index.js"]
