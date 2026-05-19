# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy built output and production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# node_modules/.bin is needed so stdio upstreams launched via npx work
ENV PATH="/app/node_modules/.bin:$PATH"

# Non-root user for security
RUN addgroup -S mcpgroup && adduser -S mcpuser -G mcpgroup \
    && mkdir -p /home/mcpuser/.npm \
    && chown -R mcpuser:mcpgroup /home/mcpuser/.npm
USER mcpuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
