# apps/storage-node/Dockerfile
# One image, reused by every storage-node-N service in docker-compose.yml — NODE_ID/NODE_PORT/
# STORAGE_PATH are supplied per-container via environment, not baked into the image.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
# Runtime has no dependencies (see package.json) — no npm install needed here.
EXPOSE 4100
CMD ["node", "dist/server.js"]