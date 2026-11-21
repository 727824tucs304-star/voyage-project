# Reusable tenant image. Build one tag per release, for example vespera-tenant:v1, vespera-tenant:v2.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=v1
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} PORT=3000 HOST=0.0.0.0
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/schema.sql ./schema.sql
RUN apk add --no-cache aws-cli \
 && mkdir -p /data \
 && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/index.js"]