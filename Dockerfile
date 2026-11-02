FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV NODE_ENV=production
EXPOSE 3000
# atualiza o yt-dlp a cada start (o YouTube muda sempre)
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
