
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 curl ca-certificates git \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Baixa o código do servidor de PO Tokens
RUN git clone --depth 1 --branch 2.0.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /opt/bgutil

RUN cd /opt/bgutil/server \
    && npm ci \
    && npx tsc

# Instala o plugin no formato correto
RUN mkdir -p /opt/yt-dlp-plugins \
 && curl -fL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip \
    -o /opt/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip

ENV YTDLP_EXTRA_ARGS="--js-runtimes node --remote-components ejs:github --plugin-dirs /opt/yt-dlp-plugins --extractor-args youtube:player-client=mweb,tv,web_safari"

COPY server.js ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 & exec node server.js"]
