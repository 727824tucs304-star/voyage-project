FROM node:22-alpine
RUN apk add --no-cache git docker-cli aws-cli \
 && git config --system --add safe.directory /workspace
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY schema.sql ./schema.sql
COPY --chmod=755 git-askpass.sh /app/git-askpass.sh
ENV NODE_ENV=production PORT=4000 GIT_ASKPASS=/app/git-askpass.sh \
    REPO_ROOT=/workspace PROJECT_SUBDIR=voyage DOCKER_BIN=docker
EXPOSE 4000
USER node
CMD ["node", "src/index.js"]
