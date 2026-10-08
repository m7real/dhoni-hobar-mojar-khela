# Alternative to render.yaml, for Fly.io or any Docker host.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so edits to the game do not bust the layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY client ./client

# Saved games go here. Mount a volume at this path in production.
ENV STORE_DIR=/data/rooms
RUN mkdir -p /data/rooms

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]