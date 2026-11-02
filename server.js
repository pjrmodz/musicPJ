
import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

const NETLIFY_ORIGIN =
  "https://glistening-souffle-c240b4.netlify.app";

const configuredOrigins = (
  process.env.ALLOWED_ORIGIN || ""
).split(",").map(origin => origin.trim()).filter(Boolean);

const allowedOrigins = new Set([
  NETLIFY_ORIGIN,
  "http://localhost:3000",
  ...configuredOrigins
]);

const allowAllOrigins = allowedOrigins.has("*");

const YTDLP_EXTRA = (
  process.env.YTDLP_EXTRA_ARGS ??
  "--js-runtimes node --remote-components ejs:github"
).split(/\s+/).filter(Boolean);

const ID_RE = /^[\w-]{11}$/;

// Biblioteca persistente
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const LIBRARY_FILE =
  process.env.MUSIC_LIBRARY_FILE ||
  path.join(DATA_DIR, "musicpj-library.json");

let library = [];
let libraryReady = false;

function loadLibrary() {
  try {
    fs.mkdirSync(path.dirname(LIBRARY_FILE), {
      recursive: true
    });

    if (fs.existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(LIBRARY_FILE, "utf8")
      );

      library = Array.isArray(data) ? data : [];
    }

    libraryReady = true;
    console.log("Biblioteca carregada:", library.length, "músicas");
  } catch (error) {
    console.error("Erro ao carregar biblioteca:", error.message);
    library = [];
    libraryReady = true;
  }
}

function saveLibrary() {
  try {
    fs.mkdirSync(path.dirname(LIBRARY_FILE), {
      recursive: true
    });

    const temporaryFile = LIBRARY_FILE + ".tmp";

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(library, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryFile, LIBRARY_FILE);
  } catch (error) {
    console.error("Erro ao salvar biblioteca:", error.message);
  }
}

loadLibrary();

// Cookies
let cookiesFile = process.env.COOKIES_FILE || "";

if (process.env.COOKIES_B64) {
  try {
    cookiesFile = path.join(os.tmpdir(), "musicpj-cookies.txt");

    fs.writeFileSync(
      cookiesFile,
      Buffer.from(process.env.COOKIES_B64, "base64"),
      { mode: 0o600 }
    );

    console.log("Cookies carregados via COOKIES_B64.");
  } catch (error) {
    console.error("Erro ao carregar cookies:", error.message);
  }
}

const app = express();

app.set("trust proxy", 1);

// CORS
const corsOptions = {
  origin(origin, callback) {
    if (
      !origin ||
      allowAllOrigins ||
      allowedOrigins.has(origin)
    ) {
      return callback(null, true);
    }

    console.warn("Origem bloqueada pelo CORS:", origin);
    return callback(null, false);
  },
  methods: ["GET", "HEAD", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Range"],
  exposedHeaders: [
    "Content-Length",
    "Accept-Ranges",
    "Content-Range",
    "Content-Disposition"
  ],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Autenticação
function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));

  return A.length === B.length && timingSafeEqual(A, B);
}

app.use((req, res, next) => {
  if (req.method === "OPTIONS" || !APP_PASSWORD) {
    return next();
  }

  if (safeEq(req.query.password || "", APP_PASSWORD)) {
    return next();
  }

  return res.status(401).json({
    error: "Senha inválida"
  });
});

// Página inicial
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "musicPJ",
    library: true,
    conversion: false
  });
});

// Saúde do servidor
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    auth: !!APP_PASSWORD,
    cookies: !!cookiesFile && fs.existsSync(cookiesFile),
    library: libraryReady,
    libraryCount: library.length,
    libraryFile: LIBRARY_FILE,
    conversion: false
  });
});

// Biblioteca de músicas
app.get("/library", (req, res) => {
  res.json({
    ok: true,
    count: library.length,
    results: library
  });
});

// Busca uma música na biblioteca
app.get("/library/:id", (req, res) => {
  const id = String(req.params.id || "");

  if (!ID_RE.test(id)) {
    return res.status(400).json({
      error: "ID inválido"
    });
  }

  const music = library.find(item => item.id === id);

  if (!music) {
    return res.status(404).json({
      error: "Música não encontrada na biblioteca"
    });
  }

  res.json({ ok: true, music });
});

// Remove uma música da biblioteca
app.delete("/library/:id", (req, res) => {
  const id = String(req.params.id || "");

  if (!ID_RE.test(id)) {
    return res.status(400).json({
      error: "ID inválido"
    });
  }

  const before = library.length;
  library = library.filter(item => item.id !== id);

  if (library.length === before) {
    return res.status(404).json({
      error: "Música não encontrada"
    });
  }

  saveLibrary();

  res.json({
    ok: true,
    count: library.length
  });
});

// Salva ou atualiza uma música na biblioteca
function rememberMusic(id, details = {}) {
  const existing = library.find(item => item.id === id);

  const title = String(details.title || "").slice(0, 200);
  const artist = String(details.artist || "").slice(0, 200);

  if (existing) {
    if (title && (!existing.title || existing.title === id)) {
      existing.title = title;
    }

    if (artist) {
      existing.artist = artist;
    }

    existing.lastPlayed = new Date().toISOString();
    existing.playCount = (existing.playCount || 0) + 1;
  } else {
    library.unshift({
      id,
      title: title || id,
      artist,
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      firstPlayed: new Date().toISOString(),
      lastPlayed: new Date().toISOString(),
      playCount: 1
    });
  }

  // Limita o histórico para não crescer indefinidamente.
  if (library.length > 1000) {
    library = library.slice(0, 1000);
  }

  saveLibrary();
}

// Argumentos do yt-dlp
function baseArgs() {
  return [
    ...YTDLP_EXTRA,
    ...(cookiesFile && fs.existsSync(cookiesFile)
      ? ["--cookies", cookiesFile]
      : []),
    "--no-warnings"
  ];
}

// Executa o yt-dlp
function runYtdlp(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      ...baseArgs(),
      ...args
    ]);

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        "Tempo esgotado ao consultar o YouTube."
      ));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      clearTimeout(timer);

      if (code === 0) {
        return resolve(stdout.trim());
      }

      const detail = stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-5)
        .join(" | ");

      reject(new Error(
        detail || `yt-dlp encerrou com código ${code}`
      ));
    });
  });
}

// Validação do ID
function validId(req, res) {
  const id = String(
    req.params.id || req.query.id || ""
  );

  if (!ID_RE.test(id)) {
    res.status(400).json({
      error: "ID do vídeo inválido"
    });

    return null;
  }

  return id;
}

// Duração
function formatDuration(value) {
  const seconds = Math.round(Number(value) || 0);

  if (!seconds) return "";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

// Cache da pesquisa
const searchCache = new Map();

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 200);

  if (!q) {
    return res.status(400).json({
      error: "Informe o termo da busca"
    });
  }

  const key = q.toLowerCase();
  const cached = searchCache.get(key);

  if (cached && Date.now() - cached.time < 600000) {
    return res.json({
      results: cached.results
    });
  }

  try {
    const raw = await runYtdlp([
      "--flat-playlist",
      "-J",
      "ytsearch15:" + q
    ], 90000);

    const data = JSON.parse(raw);

    const results = (data.entries || [])
      .filter(item => item && ID_RE.test(item.id))
      .map(item => ({
        id: item.id,
        title: item.title || "Sem título",
        artist: item.channel || item.uploader || "",
        duration: formatDuration(item.duration),
        thumbnail:
          `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`
      }));

    if (searchCache.size > 200) {
      searchCache.clear();
    }

    searchCache.set(key, {
      time: Date.now(),
      results
    });

    res.json({ results });

  } catch (error) {
    console.error("ERRO NA BUSCA:", error.message);

    res.status(502).json({
      error: "Falha na busca do YouTube",
      detail: error.message
    });
  }
});

// Cache temporário de endereços de mídia.
// Os endereços podem expirar; por isso não são salvos
// como se fossem permanentes.
const mediaUrlCache = new Map();
const MEDIA_CACHE_TTL = 5 * 60 * 1000;

async function resolveAudioUrl(id) {
  const cached = mediaUrlCache.get(id);

  if (cached && Date.now() - cached.time < MEDIA_CACHE_TTL) {
    console.log("Usando endereço em cache:", id);
    return cached.url;
  }

  const videoUrl =
    `https://www.youtube.com/watch?v=${id}`;

  console.log("Consultando formatos do vídeo:", id);

  const output = await runYtdlp([
    "--no-playlist",
    "--format",
    "bestaudio/best",
    "--get-url",
    videoUrl
  ], 90000);

  const url = output
    .split(/\r?\n/)
    .find(line => /^https?:\/\//i.test(line));

  if (!url) {
    throw new Error(
      "Nenhum endereço de mídia foi encontrado."
    );
  }

  mediaUrlCache.set(id, {
    url,
    time: Date.now()
  });

  if (mediaUrlCache.size > 300) {
    const oldest = mediaUrlCache.keys().next().value;
    mediaUrlCache.delete(oldest);
  }

  console.log("Endereço de mídia encontrado:", id);

  return url;
}

// Rota de reprodução
app.get("/stream", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    console.log("Solicitação de áudio:", id);

    await resolveAudioUrl(id);

    const searchResult = [...searchCache.values()]
      .flatMap(item => item.results)
      .find(item => item.id === id);

    rememberMusic(id, {
      title: req.query.title || searchResult?.title || id,
      artist: req.query.artist || searchResult?.artist || ""
    });

    const password = encodeURIComponent(
      String(req.query.password || "")
    );

    const url =
      `${req.protocol}://${req.get("host")}/audio/${id}?password=${password}`;

    res.json({
      ok: true,
      url
    });

  } catch (error) {
    console.error("ERRO STREAM:", error.message);

    res.status(502).json({
      error: "Não foi possível obter o áudio do YouTube.",
      detail: error.message
    });
  }
});

// Transmissão do áudio
app.get("/audio/:id", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    console.log("Iniciando transmissão:", id);

    let mediaUrl = await resolveAudioUrl(id);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      Referer: "https://www.youtube.com/"
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    let upstream = await fetch(mediaUrl, {
      headers,
      redirect: "follow"
    });

    // Se o endereço em cache expirou, tenta renovar uma vez.
    if (upstream.status === 403 || upstream.status === 410) {
      mediaUrlCache.delete(id);
      mediaUrl = await resolveAudioUrl(id);

      upstream = await fetch(mediaUrl, {
        headers,
        redirect: "follow"
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      console.error("Erro no servidor de áudio:", upstream.status);

      return res.status(502).json({
        error: `Servidor de áudio respondeu ${upstream.status}`
      });
    }

    res.status(upstream.status);

    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges"
    ]) {
      const value = upstream.headers.get(name);

      if (value) {
        res.setHeader(name, value);
      }
    }

    if (!res.hasHeader("content-type")) {
      res.setHeader("Content-Type", "audio/webm");
    }

    res.setHeader("Cache-Control", "no-store");

    if (!upstream.body) {
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);

    res.on("close", () => {
      if (!res.writableEnded) {
        body.destroy();
      }
    });

    body.on("error", error => {
      console.error("ERRO NO PROXY:", error.message);

      if (!res.headersSent) {
        res.status(502);
      }

      res.end();
    });

    body.pipe(res);

  } catch (error) {
    console.error("ERRO AUDIO:", error.message);

    if (!res.headersSent) {
      return res.status(502).json({
        error: "Falha ao transmitir o áudio.",
        detail: error.message
      });
    }

    res.end();
  }
});

// Download no formato original, sem conversão.
app.get("/download", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    const mediaUrl = await resolveAudioUrl(id);

    const upstream = await fetch(mediaUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.youtube.com/"
      }
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({
        error: `Falha no download: HTTP ${upstream.status}`
      });
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const extension = contentType.includes("mp4")
      ? "m4a"
      : "webm";

    const title = String(req.query.title || id)
      .replace(/[\\/:*?"<>|]/g, "")
      .slice(0, 100) || id;

    res.setHeader(
      "Content-Type",
      contentType || "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${title}.${extension}"`
    );

    Readable.fromWeb(upstream.body).pipe(res);

  } catch (error) {
    console.error("ERRO DOWNLOAD:", error.message);

    if (!res.headersSent) {
      return res.status(502).json({
        error: "Falha no download.",
        detail: error.message
      });
    }

    res.end();
  }
});

// Tratamento de erros
app.use((error, req, res, next) => {
  console.error("ERRO NO SERVIDOR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Erro interno do servidor"
  });
});

// Inicialização
app.listen(PORT, "0.0.0.0", () => {
  console.log(`musicPJ iniciado na porta ${PORT}`);
  console.log(
    `Senha configurada: ${APP_PASSWORD ? "sim" : "não"}`
  );
  console.log(
    `Cookies configurados: ${
      cookiesFile && fs.existsSync(cookiesFile) ? "sim" : "não"
    }`
  );
  console.log("Biblioteca persistente:", LIBRARY_FILE);
  console.log("Cache temporário de mídia ativado.");
  console.log("Conversão para MP3: desativada");
  console.log("CORS configurado para o Netlify.");
});
