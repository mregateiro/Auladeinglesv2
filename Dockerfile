FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/learn.json

# LLM config – override in docker-compose.yml or at runtime
ENV PROVIDER=ollama
ENV LLM_URL=http://host.docker.internal:11434
ENV LLM_MODEL=llama3
ENV LLM_API_KEY=

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start application
CMD ["node", "server.js"]
