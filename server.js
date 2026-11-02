
import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const YTDLP_EXTRA = (
  process.env.YTDLP_EXTRA_ARGS ??
  "--js-runtimes node --remote-components ejs:github"
).split(" ").filter(Boolean);

const ID_RE = /^[\w-]{11}$/;
let cookiesFile = process.env.COOKIES_FILE || "";

if (process.env.COOKIES_B64) {
  try {
    cookiesFile = path.join(os.tmpdir(), "musicpj-cookies.txt");
    fs.writeFileSync(
      cookiesFile,
      Buffer.from(process.env.COOKIES_B64, "base64"),
      { mode: 0o600 }
    );
    console.log("Cookies carregados.");
  } catch (e) {
    console.error("Falha ao carregar cookies:", e.message);
  }
}

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: ALLOWED_ORIGIN,
  exposedHeaders: [
    "Content-Length",
    "Accept-Ranges",
    "Content-Range",
    "Content-Disposition"
  ]
}));

function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "musicPJ" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    auth: !!APP_PASSWORD,
    cookies: !!cookiesFile && fs.existsSync(cookiesFile),
    conversion: false
  });
});

app.use((req, res, next) => {
  if (req.method === "OPTIONS" || !APP_PASSWORD) return next();

  if (safeEq(req.query.password ?? "", APP_PASSWORD)) {
    return next();
  }

  return res.status(401).json({ error: "senha inválida" });
});

function baseArgs() {
  return [
    ...YTDLP_EXTRA,
    ...(cookiesFile && fs.existsSync(cookiesFile)
      ? ["--cookies", cookiesFile]
      : []),
    "--no-warnings"
  ];
}

function runYtdlp(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [...baseArgs(), ...args]);

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tempo esgotado ao consultar o YouTube"));
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
        .slice(-3)
        .join(" | ");

      reject(new Error(
        detail || `yt-dlp encerrou com código ${code}`
      ));
    });
  });
}

function validId(req, res) {
  const id = String(req.params.id ?? req.query.id ?? "");

  if (!ID_RE.test(id)) {
    res.status(400).json({ error: "id inválido" });
    return null;
  }

  return id;
}

// Busca músicas
const searchCache = new Map();

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 200);

  if (!q) {
    return res.status(400).json({ error: "q obrigatório" });
  }

  const key = q.toLowerCase();
  const cached = searchCache.get(key);

  if (cached && Date.now() - cached.time < 600000) {
    return res.json({ results: cached.results });
  }

  try {
    const raw = await runYtdlp(
      ["--flat-playlist", "-J", `ytsearch15:${q}`],
      90000
    );

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

    return res.json({ results });

  } catch (error) {
    console.error("search:", error.message);

    return res.status(502).json({
      error: "falha na busca",
      detail: error.message
    });
  }
});

function formatDuration(value) {
  const seconds = Math.round(Number(value) || 0);

  if (!seconds) return "";

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// Obtém o endereço do áudio original.
// Não baixa nem converte para MP3.
async function resolveAudioUrl(id) {
  const output = await runYtdlp([
    "--no-playlist",
    "--format",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
    "--get-url",
    `https://www.youtube.com/watch?v=${id}`
  ], 90000);

  const url = output
    .split(/\r?\n/)
    .find(line => /^https?:\/\//i.test(line));

  if (!url) {
    throw new Error(
      "YouTube não retornou um endereço de áudio para este vídeo"
    );
  }

  return url;
}

// O player recebe o endereço do proxy local.
app.get("/stream", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    await resolveAudioUrl(id);

    const password = encodeURIComponent(
      String(req.query.password || "")
    );

    const url =
      `${req.protocol}://${req.get("host")}/audio/${id}?password=${password}`;

    return res.json({
      ok: true,
      url
    });

  } catch (error) {
    console.error("stream:", error.message);

    return res.status(502).json({
      error: "YouTube não disponibilizou o áudio",
      detail: error.message
    });
  }
});

// Transmite o áudio original e permite avançar na música.
app.get("/audio/:id", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    const mediaUrl = await resolveAudioUrl(id);

    const headers = {};

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

    headers.Referer = "https://www.youtube.com/";

    const upstream = await fetch(mediaUrl, {
      headers,
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 206) {
      const status = upstream.status === 403
        ? 502
        : upstream.status;

      return res.status(status).json({
        error: `O servidor de áudio respondeu ${upstream.status}`
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
      res.setHeader("content-type", "audio/webm");
    }

    res.setHeader("Cache-Control", "no-store");

    if (!upstream.body) {
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);

    // Encerra a transmissão se o cliente desconectar.
    res.on("close", () => {
      if (!res.writableEnded) {
        body.destroy();
      }
    });

    body.on("error", error => {
      console.error("proxy de áudio:", error.message);

      if (!res.headersSent) {
        res.status(502);
      }

      res.end();
    });

    body.pipe(res);

  } catch (error) {
    console.error("audio:", error.message);

    if (!res.headersSent) {
      res.status(502).json({
        error: "falha ao transmitir áudio",
        detail: error.message
      });
    } else {
      res.end();
    }
  }
});

// Download mantém o formato original, sem converter para MP3.
app.get("/download", async (req, res) => {
  const id = validId(req, res);
  if (!id) return;

  try {
    const mediaUrl = await resolveAudioUrl(id);

    const headers = {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.youtube.com/"
    };

    const upstream = await fetch(mediaUrl, { headers });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({
        error: `Falha no download: HTTP ${upstream.status}`
      });
    }

    const type = upstream.headers.get("content-type") || "";
    const ext = type.includes("mp4") ? "m4a" : "webm";

    const title = String(req.query.title || id)
      .replace(/[\\/:*?"<>|]/g, "")
      .slice(0, 100) || id;

    res.setHeader(
      "Content-Type",
      type || "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${title}.${ext}"`
    );

    Readable.fromWeb(upstream.body).pipe(res);

  } catch (error) {
    console.error("download:", error.message);

    if (!res.headersSent) {
      res.status(502).json({
        error: "falha no download",
        detail: error.message
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `musicPJ na porta ${PORT} (senha: ${APP_PASSWORD ? "sim" : "não"}, cookies: ${cookiesFile ? "sim" : "não"}, conversão: não)`
  );
});
