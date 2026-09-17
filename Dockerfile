# Multi-stage build

# Builder stage — needs devDependencies (TypeScript, ts-node, etc.) to compile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install ALL deps (including devDeps needed to compile TypeScript)
RUN npm ci --include=dev --no-audit --loglevel=error

# Copy source code
COPY . .

# Compile TypeScript → JavaScript
RUN npm run build

# ─────────────────────────────────────────────────────────────
# Production stage — ONLY what is needed to run the app
# We install production deps fresh here instead of copying
# node_modules from builder (which contains heavy devDeps).
# This alone can cut image size by 50–70%.
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files and install ONLY production dependencies
# (no TypeScript, no nodemon, no ts-node — saves ~150-300MB)
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --loglevel=error

# Copy compiled JS output from builder
COPY --from=builder /app/dist ./dist

# Create uploads subdirectories with correct ownership BEFORE VOLUME declaration
# so these serve as the default content of the volume when first mounted
RUN mkdir -p /app/uploads/events \
    && mkdir -p /app/uploads/messages \
    && mkdir -p /app/uploads/reports \
    && chown -R nodejs:nodejs /app/uploads

# Declare /app/uploads as a persistent volume mount point
# In Coolify: add Storage with container path = /app/uploads
VOLUME ["/app/uploads"]

# Copy entrypoint script
COPY --chown=nodejs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["/app/docker-entrypoint.sh"]