FROM node:22-alpine
WORKDIR /app

# Install dependencies first so Docker can cache this layer between builds
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
# Never run as root inside the container
USER node
CMD ["node", "src/server.js"]
