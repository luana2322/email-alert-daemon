FROM node:20-alpine

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source
COPY . .

# Hugging Face default port is 7860
ENV PORT=7860
EXPOSE 7860

# Run daemon
CMD ["node", "src/index.js"]

