# ── AI PM Developer Onboarding Copilot ──
# Build:  docker build -t ai-pm .
# Run:    docker run -p 3000:3000 -v $(pwd)/data:/app/data ai-pm
FROM node:24-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/

# Runtime configuration via env vars
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV PUBLIC_DIR=/app/public

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

EXPOSE 3000

USER node
CMD ["node", "server.js"]
