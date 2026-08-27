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

# Accept environment variables as build arguments
ARG MONGODB_URI
ARG JWT_SECRET
ARG JWT_EXPIRES_IN
ARG PORT
ARG NODE_ENV
ARG CORS_ORIGINS

# Expose them at runtime
ENV MONGODB_URI=${MONGODB_URI}
ENV JWT_SECRET=${JWT_SECRET}
ENV JWT_EXPIRES_IN=${JWT_EXPIRES_IN}
ENV PORT=${PORT}
ENV NODE_ENV=${NODE_ENV}
ENV CORS_ORIGINS=${CORS_ORIGINS}

# Copy package files and install ONLY production dependencies
# (no TypeScript, no nodemon, no ts-node — saves ~150-300MB)
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --loglevel=error

# Copy compiled JS output from builder
COPY --from=builder /app/dist ./dist

# Create uploads directory (runtime file storage, not baked into image)
RUN mkdir -p uploads && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]