# ============================================================================
# Dockerfile for Next.js Frontend
# Multi-stage build for production deployment
# ============================================================================

# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci


# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build arguments for backend URL (baked in at build time)
ARG AGENT_FRAMEWORK_URL=http://localhost:8000
ENV AGENT_FRAMEWORK_URL=${AGENT_FRAMEWORK_URL}

# Set environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build the application
RUN npm run build


# Stage 3: Production Runner
FROM node:22-alpine AS runner
WORKDIR /app

# Pass the build arg to the runner stage as well
ARG AGENT_FRAMEWORK_URL=http://localhost:8000
ENV AGENT_FRAMEWORK_URL=${AGENT_FRAMEWORK_URL}

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Caminho explícito para que a ausência do índice reprove o build, em vez de
# degradar em silêncio para a base de 25 escolas em produção.
COPY --from=builder /app/data/schools-index.json ./data/schools-index.json

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
