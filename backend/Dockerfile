FROM node:24-alpine AS base

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy package files first for better caching
COPY --chown=nodejs:nodejs package*.json ./

FROM base AS dependencies
RUN npm ci --only=production

FROM base AS production
# Copy production dependencies
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Pre-create the data mountpoint so a named volume mounted at /app/data is
# initialized with nodejs ownership (keys + evidence are written there)
RUN mkdir -p data/keys data/evidence && chown -R nodejs:nodejs data

# Switch to non-root user
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["node", "src/server.js"]
