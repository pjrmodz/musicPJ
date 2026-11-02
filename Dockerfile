
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 curl ca-certificates git \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Instala o provedor de PO Tokens
RUN git clone --depth 1 --branch 2.0.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /opt/bgutil

RUN cd /opt/bgutil/server \
    && npm ci \
    && npx tsc

# Instala o plugin do yt-dlp
ENV YTDLP_EXTRA_ARGS="--js-runtimes node --remote-components ejs:github --plugin-dirs /opt/bgutil/plugin"

COPY server.js ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["sh", "-c", "yt-dlp --verbose --js-runtimes node --remote-components ejs:github --plugin-dirs /opt/bgutil/plugin --extractor-args 'youtube:player-client=mweb,tv,web_safari' --list-formats 'https://www.youtube.com/watch?v=cWlBXqplRRY' 2>&1 | grep -E 'PO Token Providers|Generating .*PO Token|bgutil|ERROR:|Available formats'; exec node server.js"]
