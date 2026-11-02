import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const YTDLP_EXTRA = (process.env.YTDLP_EXTRA_ARGS ?? "--js-runtimes node").split(" ").filter(Boolean);
const CACHE_DIR = process.env.CACHE_DIR || "/tmp/waves-cache";
const CACHE_MAX_BYTES = Number(process.env.CACHE_MAX_MB || 400) * 1024 * 1024;
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MIN || 180) * 60_000;
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 2);
const DL_TIMEOUT_MS = 180_000;
const ID_RE = /^[\w-]{11}$/;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- cookies ----------
// prioridade: COOKIES_B64 > COOKIES_FILE
let resolvedCookiesFile = process.env.COOKIES_FILE || "";

if (process.env.COOKIES_B64) {
  try {
    const decoded = Buffer.from(process.env.COOKIES_B64, "base64").toString("utf8");
    const tmpPath = path.join(os.tmpdir(), "waves-cookies.txt");
    fs.writeFileSync(tmpPath, decoded, { mode: 0o600 });
    resolvedCookiesFile = tmpPath;
    console.log("cookies carregados via COOKIES_B64 →", tmpPath);
  } catch (e) {
    console.error("falha ao decodificar COOKIES_B64:", e.message);
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(cors({
  origin: ALLOWED_ORIGIN,
  exposedHeaders: ["Content-Disposition", "Content-Length", "Accept-Ranges", "Content-Range"]
}));

// ---------- util ----------
const fmtDur = (s) => {
  s = Math.round(Number(s) || 0);
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
};

const safeName = (s = "audio") =>
  String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 120) || "audio";

const baseArgs = () => [
  ...YTDLP_EXTRA,
  ...(resolvedCookiesFile && fs.existsSync(resolvedCookiesFile)
    ? ["--cookies", resolvedCookiesFile]
    : []),
  "--no-warnings",
];

function runYtdlp(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, [...baseArgs(), ...args]);
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      code === 0
        ? resolve(out)
        : reject(new Error(err.trim().split("\n").pop() || `yt-dlp saiu com ${code}`));
    });
  });
}

// ---------- rate limit ----------
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 240) return res.status(429).json({ error: "muitas requisições" });
  next();
});

// ---------- saúde ----------
app.get("/", (_req, res) => res.json({ ok: true, name: "waves-backend" }));
app.get("/health", (_req, res) => res.json({
  ok: true,
  auth: !!APP_PASSWORD,
  cookies: !!resolvedCookiesFile && fs.existsSync(resolvedCookiesFile),
}));

// ---------- senha ----------
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}
app.use((req, res, next) => {
  if (req.method === "OPTIONS" || !APP_PASSWORD) return next();
  if (safeEq(req.query.password ?? "", APP_PASSWORD)) return next();
  res.status(401).json({ error: "senha inválida" });
});

// ---------- busca ----------
const searchCache = new Map();
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "q obrigatório" });
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60_000) return res.json({ results: hit.results });
  try {
    const out = await runYtdlp(["--flat-playlist", "-J", `ytsearch15:${q}`]);
    const data = JSON.parse(out);
    const results = (data.entries || [])
      .filter((e) => e && ID_RE.test(e.id))
      .map((e) => ({
        id: e.id,
        title: e.title,
        artist: e.channel || e.uploader || "",
        duration: fmtDur(e.duration),
        thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      }));
    if (searchCache.size > 200) searchCache.clear();
    searchCache.set(key, { t: Date.now(), results });
    res.json({ results });
  } catch (e) {
    console.error("search:", e.message);
    res.status(502).json({ error: "falha na busca", detail: e.message });
  }
});

// ---------- fila de download ----------
const inflight = new Map();
let running = 0;
const waiting = [];
const acquire = () =>
  new Promise((ok) => (running < MAX_PARALLEL ? (running++, ok()) : waiting.push(ok)));
const release = () => { const next = waiting.shift(); next ? next() : running--; };

const fileFor = (id) => path.join(CACHE_DIR, `${id}.mp3`);

function ensureMp3(id) {
  const f = fileFor(id);
  if (fs.existsSync(f) && fs.statSync(f).size > 1024) {
    const now = new Date(); fs.utimes(f, now, now, () => {});
    return Promise.resolve(f);
  }
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    await acquire();
    try {
      await runYtdlp([
        "-f", "bestaudio", "-x",
        "--audio-format", "mp3",
        "--audio-quality", "5",
        "--no-playlist", "--no-part",
        "-o", path.join(CACHE_DIR, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${id}`,
      ], DL_TIMEOUT_MS);
      if (!fs.existsSync(f)) throw new Error("arquivo não gerado");
      return f;
    } finally { release(); }
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// ---------- limpeza de cache ----------
async function cleanCache() {
  try {
    const names = (await fsp.readdir(CACHE_DIR)).filter((n) => n.endsWith(".mp3"));
    const files = [];
    for (const n of names) {
      const p = path.join(CACHE_DIR, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st) files.push({ p, size: st.size, t: st.mtimeMs });
    }
    const now = Date.now();
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (now - f.t > CACHE_MAX_AGE_MS || total > CACHE_MAX_BYTES) {
        await fsp.unlink(f.p).catch(() => {});
        total -= f.size;
      }
    }
  } catch {}
}
setInterval(cleanCache, 10 * 60_000).unref();

const validId = (req, res) => {
  const id = String(req.params.id ?? req.query.id ?? "");
  if (!ID_RE.test(id)) { res.status(400).json({ error: "id inválido" }); return null; }
  return id;
};

// ---------- /stream ----------
app.get("/stream", async (req, res) => {
  const id = validId(req, res); if (!id) return;
  try { await ensureMp3(id); res.json({ ok: true }); }
  catch (e) {
    console.error("stream:", e.message);
    res.status(502).json({ error: "falha ao preparar áudio", detail: e.message });
  }
});

// ---------- /audio/:id ----------
app.get("/audio/:id", async (req, res) => {
  const id = validId(req, res); if (!id) return;
  try {
    const f = await ensureMp3(id);
    res.type("audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(f, { acceptRanges: true });
  } catch (e) {
    console.error("audio:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "falha ao carregar áudio", detail: e.message });
  }
});

// ---------- /download ----------
app.get("/download", async (req, res) => {
  const id = validId(req, res); if (!id) return;
  try {
    const f = await ensureMp3(id);
    res.download(f, `${safeName(req.query.title || id)}.mp3`);
  } catch (e) {
    console.error("download:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "falha no download", detail: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`waves backend na porta ${PORT} (senha: ${APP_PASSWORD ? "sim" : "não"}, cookies: ${resolvedCookiesFile ? "sim" : "não"})`)
);
