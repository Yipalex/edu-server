FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && (npm ci --omit=dev || npm install --omit=dev)
COPY src ./src
EXPOSE 3100
CMD ["node", "src/index.js"]
