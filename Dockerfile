FROM node:22-bookworm-slim

# ffmpeg makes uploaded videos stream well and creates their poster images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY admin ./admin
COPY scripts ./scripts

ENV HOST=0.0.0.0 PORT=4000 DATA_DIR=/data
VOLUME /data
EXPOSE 4000
CMD ["node", "src/server.js"]
