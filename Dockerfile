FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

WORKDIR /app

COPY . .

RUN node scripts/security/node-runtime.mjs \
    && npm ci --ignore-scripts \
    && npm run native:esbuild \
    && npm run build:production \
    && npm cache clean --force

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
