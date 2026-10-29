FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
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
