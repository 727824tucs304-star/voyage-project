FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY schema.sql ./schema.sql
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
RUN mkdir -p /etc/nginx/tenants && chown node:node /etc/nginx/tenants
USER node
CMD ["node", "src/index.js"]