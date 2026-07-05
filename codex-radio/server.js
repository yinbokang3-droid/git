import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const mediaDir = path.join(publicDir, "media");
const ttsDir = path.join(mediaDir, "tts");
const localEnvPath = path.join(__dirname, ".env.local");
const isVercel = Boolean(process.env.VERCEL);
const isReadOnlyRuntime = isVercel || process.env.READ_ONLY_DATA === "1";
await loadLocalEnv(localEnvPath);
const catalogPath = path.join(dataDir, "catalog.json");
const profilePath = path.join(dataDir, "profile.json");
const statePath = path.join(dataDir, "state.json");
const neteaseSessionPath = path.join(dataDir, "netease-session.json");
const configuredNeteaseApiBase = (process.env.NETEASE_API_BASE || "").replace(/\/$/, "");
let localNeteaseApiBase = configuredNeteaseApiBase || "http://localhost:3000";
let activeNeteaseMode = "public";
let managedNeteaseApi = null;

await mkdir(ttsDir, { recursive: true }).catch(() => {});

let catalog = JSON.parse(await readFile(catalogPath, "utf8"));
let profile = JSON.parse(await readFile(profilePath, "utf8"));
let state = JSON.parse(await readFile(statePath, "utf8"));
let neteaseSession = await readJsonFile(neteaseSessionPath, { cookie: "", profile: null });
let playlistSongIdCache = { userId: "", expiresAt: 0, ids: new Set() };
const playlistTracksCache = new Map();
const audioUrlCache = new Map();
const clients = new Set();

async function loadLocalEnv(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {}
}

async function writeJsonIfPossible(filePath, value) {
  if (isReadOnlyRuntime) return;
  try {
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    console.warn("[persist]", error.message);
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm"
};

const edgeTtsToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const edgeTtsVersion = "1-134.0.3124.66";
const neuralVoices = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "female", locale: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "female", locale: "zh-CN" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "male", locale: "zh-CN" },
  { id: "zh-CN-YunjianNeural", name: "云健", gender: "male", locale: "zh-CN" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "male", locale: "zh-CN" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北", gender: "female", locale: "zh-CN-liaoning" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮", gender: "female", locale: "zh-CN-shaanxi" }
];

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeTtsVoice(value) {
  return neuralVoices.find((voice) => voice.id === value)?.id || "zh-CN-XiaoxiaoNeural";
}

function edgePercentFromRate(value) {
  const rate = clamp(value, 0.7, 1.3, 0.96);
  const percent = Math.round((rate - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

function edgePitchFromSlider(value) {
  const pitch = clamp(value, 0.7, 1.3, 0.9);
  const hz = Math.round((pitch - 1) * 80);
  return `${hz >= 0 ? "+" : ""}${hz}Hz`;
}

function generateSecMsGec() {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const roundedTicks = ticks - (ticks % 300);
  const windowsTicks = roundedTicks * 10000000;
  return createHash("sha256").update(`${windowsTicks}${edgeTtsToken}`).digest("hex").toUpperCase();
}

function edgeTtsUrl(connectionId) {
  const params = new URLSearchParams({
    TrustedClientToken: edgeTtsToken,
    "Sec-MS-GEC": generateSecMsGec(),
    "Sec-MS-GEC-Version": edgeTtsVersion,
    ConnectionId: connectionId
  });
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?${params}`;
}

function synthesizeNeuralSpeech(text, options = {}) {
  const voice = normalizeTtsVoice(options.voice);
  const rate = edgePercentFromRate(options.rate);
  const pitch = edgePitchFromSlider(options.pitch);
  const connectionId = randomUUID().replaceAll("-", "");

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let timer;
    const ws = new WebSocket(edgeTtsUrl(connectionId), {
      origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      headers: {
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/${edgeTtsVersion.slice(2)}`
      }
    });

    const finish = (error, audio) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      error ? reject(error) : resolve(audio);
    };

    timer = setTimeout(() => finish(new Error("TTS timeout")), 15000);

    ws.on("open", () => {
      const speechConfig = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3"
            }
          }
        }
      });
      ws.send(`X-Timestamp:${new Date().toISOString()}Z\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`);

      const ssml = [
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>",
        `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>`,
        escapeXml(text),
        "</prosody></voice></speak>"
      ].join("");
      ws.send(`X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on("message", (rawData, isBinary) => {
      const data = Buffer.from(rawData);
      const textFrame = isBinary ? data.toString("utf8", 0, Math.min(data.length, 200)) : data.toString("utf8");
      if (textFrame.includes("turn.end")) {
        const audio = Buffer.concat(chunks);
        return audio.length ? finish(null, audio) : finish(new Error("TTS returned empty audio"));
      }
      const separator = Buffer.from("Path:audio\r\n");
      const index = data.indexOf(separator);
      if (index >= 0) chunks.push(data.subarray(index + separator.length));
    });

    ws.on("error", (error) => finish(error));
    ws.on("close", () => {
      if (!settled) finish(new Error("TTS connection closed early"));
    });
  });
}

async function handleTts(req, res) {
  const body = await readBody(req);
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (!text) return sendJson(res, { error: "empty text" }, 400);

  const voice = normalizeTtsVoice(body.voice || profile.neuralVoice);
  const rate = clamp(body.rate ?? profile.voiceRate, 0.7, 1.3, 0.96);
  const pitch = clamp(body.pitch ?? profile.voicePitch, 0.7, 1.3, 0.9);
  const key = createHash("sha256").update(JSON.stringify({ text, voice, rate, pitch, v: 1 })).digest("hex").slice(0, 28);
  const filename = `${key}.mp3`;
  const filePath = path.join(ttsDir, filename);

  if (!isReadOnlyRuntime) {
    try {
      await stat(filePath);
      return sendJson(res, { audioUrl: `/media/tts/${filename}`, voice, cached: true });
    } catch {}
  }

  try {
    const audio = await synthesizeNeuralSpeech(text, { voice, rate, pitch });
    if (isReadOnlyRuntime) {
      return sendJson(res, {
        audioUrl: `data:audio/mpeg;base64,${audio.toString("base64")}`,
        voice,
        cached: false
      });
    }
    await writeFile(filePath, audio);
    return sendJson(res, { audioUrl: `/media/tts/${filename}`, voice, cached: false });
  } catch (error) {
    console.warn("[TTS]", error.message);
    return sendJson(res, { error: "真人语音暂时生成失败" }, 502);
  }
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

function currentContext() {
  const hour = new Date().getHours();
  const segment = hour < 11 ? "morning" : hour < 17 ? "work" : hour < 21 ? "evening" : "night";
  const weather = hour > 20 || hour < 7 ? "夜色" : hour % 3 === 0 ? "微雨" : "晴间多云";
  return {
    now: new Date().toISOString(),
    time: nowLabel(),
    segment,
    weather,
    city: profile.city || "本地"
  };
}

function getTrack(id) {
  return catalog.find((track) => track.id === id) || catalog[0];
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function stableHash(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function makeTrackId(prefix, rawId) {
  const base = String(rawId || Date.now()).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  return `${prefix}-${base || Date.now()}`;
}

function makeColors(seedText) {
  const hash = stableHash(seedText);
  const hue = hash % 360;
  return [
    `hsl(${hue} 38% 24%)`,
    `hsl(${(hue + 54) % 360} 58% 56%)`,
    `hsl(${(hue + 132) % 360} 45% 48%)`
  ];
}

function normalizeTagList(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function inferTrackTags(track) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  const tags = ["netease", "imported"];
  if (/live|现场/.test(text)) tags.push("live");
  if (/夜|晚安|moon|night/.test(text)) tags.push("night");
  if (/雨|rain/.test(text)) tags.push("rain");
  if (/钢琴|piano/.test(text)) tags.push("piano", "calm");
  if (/电音|electro|remix|mix/.test(text)) tags.push("electronic");
  if (/工作|focus|code/.test(text)) tags.push("focus");
  if (tags.length < 4) tags.push("clean");
  return uniqueIds(tags);
}

function normalizeTrack(track) {
  const title = String(track.title || track.name || "未命名歌曲").trim();
  const artist = String(track.artist || "未知艺人").trim();
  const album = String(track.album || "网易云音乐").trim();
  const duration = Math.max(30, Number(track.duration || 240) || 240);
  const energy = Math.min(5, Math.max(1, Number(track.energy || 3) || 3));
  const id = String(track.id || makeTrackId(track.source || "local", `${title}-${artist}`));
  const tags = normalizeTagList(track.tags?.length ? track.tags : inferTrackTags({ title, artist, album }));

  return {
    id,
    title,
    artist,
    album,
    duration,
    bpm: Number(track.bpm || 96 + energy * 6),
    energy,
    tone: Number(track.tone || 160 + (stableHash(`${title}-${artist}`) % 150)),
    mood: String(track.mood || tags.find((tag) => !["netease", "imported"].includes(tag)) || "imported"),
    tags,
    colors: track.colors?.length ? track.colors : makeColors(`${title}-${artist}`),
    source: track.source || "local",
    neteaseId: track.neteaseId ? String(track.neteaseId) : undefined,
    externalUrl: track.externalUrl || undefined,
    coverUrl: track.coverUrl || track.picUrl || track.albumPicUrl || track.coverImgUrl || undefined,
    audioUrl: track.audioUrl || undefined
  };
}

async function saveCatalog() {
  await writeJsonIfPossible(catalogPath, catalog);
}

function upsertTrack(track) {
  const normalized = normalizeTrack(track);
  const index = catalog.findIndex((item) => item.id === normalized.id || (normalized.neteaseId && item.neteaseId === normalized.neteaseId));
  if (index >= 0) {
    catalog[index] = { ...catalog[index], ...normalized };
    return catalog[index];
  }
  catalog.unshift(normalized);
  return normalized;
}

function mapNeteaseSong(song) {
  const artists = song.artists || song.ar || [];
  const album = song.album || song.al || {};
  const artist = artists.map((item) => item.name).filter(Boolean).join(" / ") || "网易云音乐";
  const title = song.name || song.title || "网易云歌曲";
  const neteaseId = String(song.id);
  const coverUrl = album.picUrl || album.blurPicUrl || song.picUrl || song.coverUrl || song.coverImgUrl || "";

  return {
    id: makeTrackId("netease", neteaseId),
    source: "netease",
    neteaseId,
    title,
    artist,
    album: album.name || "网易云音乐",
    duration: Math.max(30, Math.round(Number(song.duration || song.dt || 240000) / 1000)),
    tags: inferTrackTags({ title, artist, album: album.name }),
    colors: makeColors(`${title}-${artist}-${neteaseId}`),
    externalUrl: `https://music.163.com/#/song?id=${neteaseId}`,
    coverUrl,
    audioUrl: `https://music.163.com/song/media/outer/url?id=${neteaseId}.mp3`
  };
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 6000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://music.163.com/",
        ...(fetchOptions.headers || {})
      },
      ...fetchOptions,
      signal: fetchOptions.signal || controller.signal
    });
    if (!response.ok) throw new Error(`NetEase request failed: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function neteaseEndpointName(endpoint) {
  return String(endpoint || "").replace(/^\/+/, "").replace(/\/+/g, "_");
}

async function callBundledNeteaseApi(endpoint, params = {}, options = {}) {
  const api = require("NeteaseCloudMusicApi");
  const name = neteaseEndpointName(endpoint);
  const fn = api[name];
  if (typeof fn !== "function") throw new Error(`NeteaseCloudMusicApi missing endpoint: ${name}`);
  const body = { ...params };
  const cookie = options.withCookie === false ? "" : getNeteaseCookieHeader();
  if (cookie) body.cookie = cookie;
  const timeoutMs = options.timeoutMs || 5000;
  const result = await Promise.race([
    fn(body),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Netease direct call timed out: ${name}`)), timeoutMs))
  ]);
  const payload = result?.body || result || {};
  if (result?.cookie && !payload.cookie) {
    payload.cookie = Array.isArray(result.cookie) ? result.cookie.join("; ") : String(result.cookie);
  }
  return payload;
}

async function isNeteaseApiReachable(baseUrl = localNeteaseApiBase) {
  if (isVercel && !configuredNeteaseApiBase) {
    try {
      await callBundledNeteaseApi("/login/status", {}, { timeoutMs: 900, withCookie: false });
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fetchJson(`${baseUrl}/login/status?timestamp=${Date.now()}`, { timeoutMs: 700 });
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

async function findFreePort(start = 3000) {
  for (let port = start; port < start + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("找不到可用的网易云 API 端口");
}

async function startManagedNeteaseApi() {
  if (configuredNeteaseApiBase) {
    activeNeteaseMode = await isNeteaseApiReachable(configuredNeteaseApiBase) ? "NeteaseCloudMusicApi" : "public";
    return;
  }

  if (isVercel) {
    activeNeteaseMode = await isNeteaseApiReachable() ? "NeteaseCloudMusicApi" : "public";
    return;
  }

  if (await isNeteaseApiReachable("http://localhost:3000")) {
    localNeteaseApiBase = "http://localhost:3000";
    activeNeteaseMode = "NeteaseCloudMusicApi";
    return;
  }

  const port = await findFreePort(3000);
  localNeteaseApiBase = `http://localhost:${port}`;
  try {
    const generateConfig = require("NeteaseCloudMusicApi/generateConfig");
    await generateConfig();
  } catch {}

  const { serveNcmApi } = require("NeteaseCloudMusicApi/server");
  managedNeteaseApi = await serveNcmApi({
    port,
    host: "127.0.0.1",
    checkVersion: false
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await isNeteaseApiReachable(localNeteaseApiBase)) {
      activeNeteaseMode = "NeteaseCloudMusicApi";
      return;
    }
    await wait(250);
  }
}

async function saveNeteaseSession() {
  await writeJsonIfPossible(neteaseSessionPath, neteaseSession);
}

function hasNeteaseCookie() {
  return Boolean(neteaseSession.cookie);
}

function getNeteaseCookieHeader() {
  const ignored = new Set(["Max-Age", "Expires", "Path", "Domain", "SameSite", "Secure", "HttpOnly"]);
  const pairs = new Map();
  for (const part of String(neteaseSession.cookie || "").split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || ignored.has(key)) continue;
    pairs.set(key, value);
  }
  return [...pairs.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function callNeteaseApi(endpoint, params = {}, options = {}) {
  if (isVercel && !configuredNeteaseApiBase) {
    activeNeteaseMode = "NeteaseCloudMusicApi";
    return callBundledNeteaseApi(endpoint, params, options);
  }

  const url = new URL(endpoint, `${localNeteaseApiBase}/`);
  url.searchParams.set("timestamp", String(Date.now()));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  activeNeteaseMode = "NeteaseCloudMusicApi";
  const headers = {};
  if (hasNeteaseCookie() && options.withCookie !== false) {
    const cookie = getNeteaseCookieHeader();
    if (cookie) headers.Cookie = cookie;
  }
  return fetchJson(url.toString(), { timeoutMs: options.timeoutMs || 5000, headers });
}

async function getNeteaseLoginStatus() {
  try {
    const data = await callNeteaseApi("/login/status", {}, { timeoutMs: 1800 });
    const profile = data.data?.profile || data.profile || null;
    if (profile) {
      const previousUserId = String(neteaseSession.profile?.userId || "");
      neteaseSession.profile = {
        userId: profile.userId,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl
      };
      if (previousUserId && previousUserId !== String(profile.userId)) {
        playlistSongIdCache = { userId: "", expiresAt: 0, ids: new Set() };
        playlistTracksCache.clear();
        audioUrlCache.clear();
      }
      await saveNeteaseSession();
    }
    return {
      apiAvailable: true,
      loggedIn: Boolean(profile),
      profile: neteaseSession.profile,
      mode: "NeteaseCloudMusicApi"
    };
  } catch {
    activeNeteaseMode = "public";
    return {
      apiAvailable: false,
      loggedIn: false,
      profile: null,
      mode: "public",
      message: "请先启动本机 NeteaseCloudMusicApi。"
    };
  }
}

async function createNeteaseQrLogin() {
  const keyData = await callNeteaseApi("/login/qr/key", {}, { withCookie: false });
  const key = keyData.data?.unikey || keyData.unikey;
  if (!key) throw new Error("无法生成网易云登录二维码 key");
  const qrData = await callNeteaseApi("/login/qr/create", { key, qrimg: "true" }, { withCookie: false });
  return {
    key,
    qrimg: qrData.data?.qrimg || qrData.qrimg,
    qrurl: qrData.data?.qrurl || qrData.qrurl
  };
}

async function checkNeteaseQrLogin(key) {
  const data = await callNeteaseApi("/login/qr/check", { key }, { withCookie: false });
  if (data.code === 803 && data.cookie) {
    neteaseSession.cookie = data.cookie;
    await getNeteaseLoginStatus();
    await saveNeteaseSession();
  }
  return {
    code: data.code,
    message: data.message,
    loggedIn: data.code === 803,
    profile: neteaseSession.profile
  };
}

async function getNeteasePlaylists() {
  const status = await getNeteaseLoginStatus();
  if (!status.apiAvailable) throw new Error("NeteaseCloudMusicApi 未启动");
  if (!status.loggedIn || !status.profile?.userId) throw new Error("网易云账号未登录");
  const data = await callNeteaseApi("/user/playlist", {
    uid: status.profile.userId,
    limit: 100
  });
  return (data.playlist || []).map((item) => ({
    id: String(item.id),
    name: item.name,
    trackCount: item.trackCount,
    coverImgUrl: item.coverImgUrl,
    creator: item.creator?.nickname || status.profile.nickname
  }));
}

async function getNeteasePlaylistTracks(id, options = {}) {
  const limit = Math.min(500, Math.max(20, Number(options.limit || 40)));
  const offset = Math.max(0, Number(options.offset || 0));
  const cacheKey = `${id}:${offset}:${limit}`;
  const cached = playlistTracksCache.get(cacheKey);
  if (!options.force && cached?.expiresAt > Date.now()) return cached.songs;

  let songs = [];
  try {
    const data = await callNeteaseApi("/playlist/track/all", { id, limit, offset }, { timeoutMs: 3500 });
    songs = data.songs || [];
  } catch {
    const detail = await callNeteaseApi("/playlist/detail", { id }, { timeoutMs: 3500 });
    songs = (detail.playlist?.tracks || []).slice(offset, offset + limit);
  }
  const mapped = songs.map(mapNeteaseSong);
  playlistTracksCache.set(cacheKey, { songs: mapped, expiresAt: Date.now() + 5 * 60 * 1000 });
  return mapped;
}

async function searchNetease(keyword, limit = 12) {
  const cleanKeyword = String(keyword || "").trim();
  if (!cleanKeyword) return [];

  try {
    const data = await callNeteaseApi("/search", { keywords: cleanKeyword, limit, type: 1 }, {
      timeoutMs: configuredNeteaseApiBase || isVercel ? 5000 : 900,
      withCookie: false
    });
    activeNeteaseMode = "NeteaseCloudMusicApi";
    return (data.result?.songs || []).map(mapNeteaseSong);
  } catch {
    activeNeteaseMode = "public";
  }

  const body = new URLSearchParams({
    s: cleanKeyword,
    type: "1",
    offset: "0",
    total: "true",
    limit: String(limit)
  });
  const data = await fetchJson("https://music.163.com/api/search/get/web", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return (data.result?.songs || []).map(mapNeteaseSong);
}

async function getNeteaseSongDetail(neteaseId) {
  if (!neteaseId) return null;
  try {
    const data = await callNeteaseApi("/song/detail", { ids: neteaseId }, { timeoutMs: 2500 });
    return data.songs?.[0] ? mapNeteaseSong(data.songs[0]) : null;
  } catch {
    return null;
  }
}

async function resolveNeteaseAudioUrl(track) {
  const resolved = await resolveNeteaseAudio(track);
  return resolved.url || track.audioUrl;
}

function describeNeteaseUrlFailure(failures) {
  const flat = failures.flatMap((item) => item.items || []);
  const codes = [...new Set(flat.map((item) => item.code).filter(Boolean))];
  const messages = [...new Set(flat.map((item) => item.message || item.msg || item.level).filter(Boolean))];
  if (flat.some((item) => item.freeTrialInfo || item.freeTrialPrivilege)) return "这首歌只有试听片段或需要会员权限，网易云没有返回完整播放链接。";
  if (codes.includes(404)) return "网易云返回无版权或资源不存在。";
  if (codes.includes(-110) || codes.includes(20001)) return "这首歌受版权或地区限制，当前账号不能播放。";
  if (messages.length) return messages.slice(0, 3).join("；");
  return "网易云没有给当前账号返回可播放链接。";
}

function pickPlayableUrl(data) {
  const items = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  const playable = items.find((item) => item?.url);
  return {
    url: playable?.url || "",
    item: playable || items[0] || null,
    items
  };
}

function getCachedNeteaseAudio(neteaseId) {
  const cached = audioUrlCache.get(String(neteaseId || ""));
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    audioUrlCache.delete(String(neteaseId || ""));
    return null;
  }
  return cached;
}

function cacheNeteaseAudio(neteaseId, result) {
  const id = String(neteaseId || "");
  if (!id) return;
  const ttl = result.url ? 45 * 60 * 1000 : 4 * 60 * 1000;
  audioUrlCache.set(id, { ...result, expiresAt: Date.now() + ttl });
}

async function resolveNeteaseAudio(track, options = {}) {
  if (!track.neteaseId) {
    return { url: track.audioUrl || "", source: track.audioUrl ? "existing" : "none", reason: "" };
  }

  const cached = !options.force ? getCachedNeteaseAudio(track.neteaseId) : null;
  if (cached) return { ...cached, source: cached.url ? "cache" : "cache-failed" };

  const failures = [];
  const levels = options.deep ? ["standard", "higher", "exhigh", "lossless"] : ["standard", "higher"];

  for (const level of levels) {
    try {
      const data = await callNeteaseApi("/song/url/v1", { id: track.neteaseId, level }, {
        timeoutMs: configuredNeteaseApiBase ? 3000 : 1600
      });
      const picked = pickPlayableUrl(data);
      if (picked.url) {
        const result = { url: picked.url, source: "song/url/v1", level, item: picked.item };
        cacheNeteaseAudio(track.neteaseId, result);
        return result;
      }
      failures.push({ endpoint: "song/url/v1", level, items: picked.items });
    } catch (error) {
      failures.push({ endpoint: "song/url/v1", level, items: [{ message: error.message }] });
    }
  }

  try {
    const data = await callNeteaseApi("/song/url", { id: track.neteaseId }, {
      timeoutMs: configuredNeteaseApiBase ? 3000 : 1600
    });
    const picked = pickPlayableUrl(data);
    if (picked.url) {
      const result = { url: picked.url, source: "song/url", item: picked.item };
      cacheNeteaseAudio(track.neteaseId, result);
      return result;
    }
    failures.push({ endpoint: "song/url", items: picked.items });
  } catch (error) {
    failures.push({ endpoint: "song/url", items: [{ message: error.message }] });
  }

  for (const level of (options.deep ? ["standard", "higher"] : [])) {
    try {
      const data = await callNeteaseApi("/song/download/url/v1", { id: track.neteaseId, level }, {
        timeoutMs: configuredNeteaseApiBase ? 3000 : 1600
      });
      const url = data.data?.url || data.data;
      if (typeof url === "string" && url) {
        const result = { url, source: "song/download/url/v1", level, item: data.data };
        cacheNeteaseAudio(track.neteaseId, result);
        return result;
      }
      failures.push({ endpoint: "song/download/url/v1", level, items: [data.data || data] });
    } catch (error) {
      failures.push({ endpoint: "song/download/url/v1", level, items: [{ message: error.message }] });
    }
  }

  const result = {
    url: "",
    source: "none",
    reason: describeNeteaseUrlFailure(failures),
    failures
  };
  cacheNeteaseAudio(track.neteaseId, result);
  return result;
}

function compactTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    tags: track.tags,
    source: track.source || "local",
    playable: Boolean(track.audioUrl)
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeAiCommand(command, message) {
  const action = String(command?.action || "recommend").toLowerCase();
  return {
    action,
    say: String(command?.say || "").slice(0, 220),
    query: String(command?.query || "").trim(),
    tags: normalizeTagList(command?.tags || []),
    energy: command?.energy ? Math.min(5, Math.max(1, Number(command.energy))) : null,
    reason: String(command?.reason || "").slice(0, 240),
    original: message
  };
}

async function askDeepSeekForCommand(message) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const context = currentContext();
  const payload = {
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    thinking: { type: "disabled" },
    messages: [
      {
        role: "system",
        content: [
          "你是 Codex Radio 的 DJ 指令解析器。",
          "只返回 JSON，不要 Markdown。",
          "你要把用户自然语言转成可执行动作。",
          "可用 action: recommend, search_play, next, like, dislike, plan, explain, stop。",
          "recommend 用于按心情/场景重排队列；search_play 用于用户明确要播放某首歌、某歌手或某关键词；next 用于下一首；like/dislike 用于反馈当前歌；plan 用于今日计划；explain 用于解释当前选择；stop 用于暂停意图。",
          "JSON 格式: {\"action\":\"recommend\",\"say\":\"给用户听的短句\",\"query\":\"歌曲/歌手/关键词，可空\",\"tags\":[\"focus\"],\"energy\":1-5,\"reason\":\"简短原因\"}"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          userMessage: message,
          context,
          profile: {
            preferredTags: profile.preferredTags || [],
            blockedTags: profile.blockedTags || [],
            routines: profile.routines || {}
          },
          current: compactTrack(getTrack(state.currentTrackId || state.queue?.[0])),
          queue: (state.queue || []).map(getTrack).slice(0, 8).map(compactTrack),
          catalog: catalog.slice(0, 60).map(compactTrack)
        })
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 500
  };

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`DeepSeek request failed: ${response.status} ${errorText.slice(0, 120)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(content);
  return parsed ? normalizeAiCommand(parsed, message) : null;
}

function localCommandFallback(message) {
  const lower = message.toLowerCase();
  if (/换|下一首|skip|next/.test(lower)) return { action: "next", say: "好，换一首。", tags: [], query: "", energy: null, reason: "用户要求切歌。" };
  if (/喜欢|收藏|like/.test(lower)) return { action: "like", say: "记住了，我会多放这种质感。", tags: [], query: "", energy: null, reason: "用户喜欢当前歌曲。" };
  if (/不喜欢|别放|dislike/.test(lower)) return { action: "dislike", say: "收到，这类声音先降权。", tags: [], query: "", energy: null, reason: "用户不喜欢当前歌曲。" };
  if (/计划|安排|今天/.test(lower)) return { action: "plan", say: "我重新排一下今天的四段电台。", tags: [], query: "", energy: null, reason: "用户要求生成计划。" };
  if (/播放|放一首|来一首|听/.test(lower)) {
    const query = message.replace(/播放|放一首|来一首|我想听|想听|听/g, "").trim();
    return { action: query ? "search_play" : "recommend", say: query ? `我去找「${query}」。` : "我按你的状态重排。", query, tags: [], energy: null, reason: "本地规则识别播放意图。" };
  }
  const intent = inferIntent(message);
  return { action: "recommend", say: "我按你的状态重排队列。", query: "", tags: intent.tags || [], energy: intent.energy, reason: "本地规则识别心情和场景。" };
}

function matchCatalog(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  return catalog.find((track) => {
    const haystack = `${track.title} ${track.artist} ${track.album} ${(track.tags || []).join(" ")}`.toLowerCase();
    return haystack.includes(q);
  }) || null;
}

async function searchAndPlay(query) {
  const local = matchCatalog(query);
  if (local) return local;
  const results = await searchNetease(query, 8);
  for (const result of results) {
    const resolved = await resolveNeteaseAudio(result);
    result.audioUrl = resolved.source === "outer-url-fallback" ? "" : resolved.url;
    if (result.audioUrl) return upsertTrack(result);
  }
  return null;
}

async function playNeteaseSong(song, reason) {
  const baseTrack = normalizeTrack({
    ...song,
    source: "netease"
  });
  const resolved = await resolveNeteaseAudio(baseTrack);
  baseTrack.audioUrl = resolved.source === "outer-url-fallback" ? "" : resolved.url;
  if (!baseTrack.audioUrl) {
    const error = new Error(resolved.reason || "网易云没有给当前账号返回可播放链接。");
    error.code = "NETEASE_NO_PLAYABLE_URL";
    error.status = 422;
    throw error;
  }

  const track = upsertTrack(baseTrack);
  state.currentTrackId = track.id;
  state.queue = uniqueIds([track.id, ...(state.queue || [])]).slice(0, 10);
  state.lastReason = reason || `正在播放网易云搜索到的《${track.title}》。`;
  await saveAll();
  broadcast("catalog", getPayload());
  return track;
}

async function refreshNeteaseTrackAudio(track) {
  if (!track?.neteaseId) return track;
  let enriched = track;
  if (!track.coverUrl) {
    const detail = await getNeteaseSongDetail(track.neteaseId);
    if (detail?.coverUrl) enriched = { ...track, coverUrl: detail.coverUrl, album: track.album || detail.album };
  }
  const resolved = await resolveNeteaseAudio(enriched);
  if (!resolved.url) {
    const error = new Error(resolved.reason || "网易云没有给当前账号返回可播放链接。");
    error.code = "NETEASE_NO_PLAYABLE_URL";
    error.status = 422;
    throw error;
  }
  return upsertTrack({ ...enriched, audioUrl: resolved.url, source: "netease" });
}

async function executeDjCommand(command) {
  let say = command.say || "收到。";
  let reason = command.reason || "";

  if (command.action === "next") {
    advanceTrack();
    const current = getTrack(state.currentTrackId);
    say ||= `换到《${current.title}》。`;
    reason ||= "用户要求下一首。";
  } else if (command.action === "like") {
    addFeedback(state.currentTrackId, "like");
    reason ||= "已提升当前歌曲权重。";
  } else if (command.action === "dislike") {
    addFeedback(state.currentTrackId, "dislike");
    advanceTrack();
    const current = getTrack(state.currentTrackId);
    say ||= `先避开这类声音，换到《${current.title}》。`;
    reason ||= "已降低当前歌曲权重并切歌。";
  } else if (command.action === "plan") {
    createPlan();
    reason ||= "已按早间、专注、傍晚、夜里重排。";
  } else if (command.action === "search_play") {
    const track = await searchAndPlay(command.query || command.original);
    if (track) {
      state.currentTrackId = track.id;
      state.queue = uniqueIds([track.id, ...(state.queue || [])]).slice(0, 10);
      say ||= `找到《${track.title}》，现在播放。`;
      reason ||= `按关键词「${command.query || command.original}」搜索并加入队列。`;
    } else {
      say = "我没找到这首歌，可以换个歌名或歌手再试。";
      reason = "搜索没有结果。";
    }
  } else if (command.action === "stop") {
    say ||= "好，我先停下。";
    reason ||= "用户要求暂停。";
  } else if (command.action === "explain") {
    reason ||= state.lastReason || "当前队列按你的偏好和时段生成。";
  } else {
    const intent = {
      tags: command.tags?.length ? command.tags : inferIntent(command.original).tags,
      energy: command.energy || inferIntent(command.original).energy,
      segment: currentContext().segment
    };
    const picks = recommend(intent, 8);
    state.currentTrackId = picks[0]?.id || state.currentTrackId;
    state.queue = uniqueIds([...picks.map((track) => track.id), ...(state.queue || [])]).slice(0, 10);
    const current = getTrack(state.currentTrackId);
    say ||= `我选《${current.title}》开场。`;
    reason ||= `按 ${intent.tags?.slice(0, 3).join("、") || "当前状态"} 重排队列。`;
  }

  state.lastReason = reason;
  return { say, reason, payload: getPayload() };
}

function scoreTrack(track, intent = {}) {
  let score = 0;
  const preferred = new Set(profile.preferredTags || []);
  const blocked = new Set(profile.blockedTags || []);
  const wanted = new Set(intent.tags || []);

  for (const tag of track.tags) {
    if (preferred.has(tag)) score += 3;
    if (wanted.has(tag)) score += 5;
    if (blocked.has(tag)) score -= 8;
  }

  if (intent.energy) score -= Math.abs(track.energy - intent.energy) * 1.4;
  if (intent.segment && track.tags.includes(intent.segment)) score += 4;
  if (state.likes?.includes(track.id)) score += 4;
  if (state.dislikes?.includes(track.id)) score -= 7;
  if (state.history?.slice(-4).includes(track.id)) score -= 5;

  return score;
}

function recommend(intent = {}, limit = 6) {
  return [...catalog]
    .sort((a, b) => scoreTrack(b, intent) - scoreTrack(a, intent))
    .slice(0, limit);
}

function shuffleItems(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function uniqueTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const key = track.neteaseId ? `netease:${track.neteaseId}` : track.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recommendationIntent() {
  const current = getTrack(state.currentTrackId || state.queue?.[0]);
  const listened = [
    current,
    ...(state.likes || []).map(getTrack),
    ...(state.history || []).slice(-8).map(getTrack)
  ].filter(Boolean);
  const tags = uniqueIds([
    ...(profile.preferredTags || []),
    ...listened.flatMap((track) => track.tags || [])
  ]).filter((tag) => !(profile.blockedTags || []).includes(tag));
  const energy = listened.length
    ? listened.reduce((sum, track) => sum + (Number(track.energy) || 3), 0) / listened.length
    : undefined;
  return {
    tags: tags.length ? tags : currentContext().segment ? [currentContext().segment, "clean"] : ["clean"],
    energy,
    segment: currentContext().segment
  };
}

function localRecommendations(limit = 8) {
  const intent = recommendationIntent();
  const excluded = new Set([state.currentTrackId, ...(state.history || []).slice(-5), ...(state.dislikes || [])]);
  return shuffleItems(catalog)
    .filter((track) => !excluded.has(track.id))
    .filter((track) => !(track.tags || []).some((tag) => (profile.blockedTags || []).includes(tag)))
    .map((track) => ({
      ...track,
      recommendationSource: track.source === "netease" ? "听过的网易云" : "本地曲库",
      recommendationScore: scoreTrack(track, intent) + Math.random() * 3
    }))
    .sort((a, b) => b.recommendationScore - a.recommendationScore)
    .slice(0, limit);
}

function recommendationSearchQueries(intent) {
  const map = {
    focus: ["安静 工作 华语", "专注 中文歌", "适合写代码的歌"],
    calm: ["安静 中文流行", "温柔 华语", "治愈 中文歌"],
    clean: ["清爽 华语", "干净女声", "清新中文歌"],
    warm: ["温暖 中文歌", "温柔男声 华语"],
    electronic: ["中文电子", "电子流行 华语"],
    morning: ["早晨 清爽 中文歌"],
    night: ["夜晚 安静 中文歌", "睡前 中文歌"],
    ambient: ["氛围感 中文歌"],
    soft: ["柔和 中文歌"],
    bright: ["明亮 流行 中文歌"],
    uplift: ["提神 中文歌"],
    commute: ["通勤 华语流行"],
    reading: ["适合阅读的歌"],
    work: ["工作 安静 中文歌"],
    rain: ["雨天 中文歌"]
  };
  const queries = intent.tags.flatMap((tag) => map[tag] || []);
  return uniqueIds([...queries, "华语流行", "小众中文歌", "网易云热歌", "私人雷达 华语"]);
}

async function accountRecommendationPool(limit = 18) {
  if (!neteaseSession.profile) return [];
  try {
    const playlists = shuffleItems((await getNeteasePlaylists()).filter((item) => item.trackCount > 0)).slice(0, 5);
    const groups = await Promise.all(playlists.map(async (playlist) => {
      try {
        return (await getNeteasePlaylistTracks(playlist.id)).map((track) => ({
          ...track,
          recommendationSource: `歌单 · ${playlist.name}`
        }));
      } catch {
        return [];
      }
    }));
    return shuffleItems(uniqueTracks(groups.flat())).slice(0, limit);
  } catch {
    return [];
  }
}

async function getPlaylistSongIdSet() {
  const userId = String(neteaseSession.profile?.userId || "");
  if (!userId) return new Set();
  if (playlistSongIdCache.userId === userId && playlistSongIdCache.expiresAt > Date.now()) {
    return new Set(playlistSongIdCache.ids);
  }

  try {
    const playlists = (await getNeteasePlaylists()).filter((item) => item.trackCount > 0);
    const groups = await Promise.all(playlists.map(async (playlist) => {
      try {
        return await getNeteasePlaylistTracks(playlist.id, { limit: 500 });
      } catch {
        return [];
      }
    }));
    const ids = new Set(groups.flat().map((track) => String(track.neteaseId || "")).filter(Boolean));
    playlistSongIdCache = { userId, ids, expiresAt: Date.now() + 10 * 60 * 1000 };
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function searchedRecommendationPool(intent, limit = 12, excludedNeteaseIds = new Set()) {
  const queries = shuffleItems(recommendationSearchQueries(intent)).slice(0, 8);
  const groups = await Promise.all(queries.map(async (query) => {
    try {
      return (await searchNetease(query, 12)).map((track) => ({
        ...track,
        recommendationSource: `搜索 · ${query}`,
        audioUrl: ""
      }));
    } catch {
      return [];
    }
  }));
  return shuffleItems(uniqueTracks(groups.flat()))
    .filter((track) => !excludedNeteaseIds.has(String(track.neteaseId || "")))
    .slice(0, limit);
}

async function createRecommendations(limit = 8) {
  const intent = recommendationIntent();
  const playlistSongIds = await getPlaylistSongIdSet();
  const searched = await searchedRecommendationPool(intent, Math.max(limit * 4, 24), playlistSongIds);
  const blocked = new Set([state.currentTrackId, ...(state.history || []).slice(-4), ...(state.dislikes || [])]);
  const recommendations = uniqueTracks(searched)
    .filter((track) => !blocked.has(track.id))
    .filter((track) => !playlistSongIds.has(String(track.neteaseId || "")))
    .slice(0, limit)
    .map((track) => {
      const normalized = normalizeTrack(track);
      return {
        ...normalized,
        recommendationSource: track.recommendationSource || "网易云随机发现"
      };
    });
  state.recommendations = recommendations;
  state.lastReason = "根据你的偏好和最近播放，从网易云随机搜索了一组不在你歌单里的新推荐。";
  await saveAll();
  return recommendations;
}

function inferIntent(message = "") {
  const text = message.toLowerCase();
  const tags = [];
  let energy = null;

  if (/专注|工作|写|代码|debug|效率|focus/.test(text)) {
    tags.push("focus", "work", "steady");
    energy = 3;
  }
  if (/早|起床|上午|晨/.test(text)) {
    tags.push("morning", "fresh", "clean");
    energy = energy || 2;
  }
  if (/晚上|夜|睡|放松|安静/.test(text)) {
    tags.push("night", "soft", "ambient");
    energy = 1;
  }
  if (/开心|提神|嗨|快|动起来/.test(text)) {
    tags.push("bright", "uplift");
    energy = 4;
  }
  if (/雨|阴|emo|难受/.test(text)) {
    tags.push("rain", "calm", "soft");
    energy = Math.min(energy || 2, 2);
  }
  if (/通勤|路上|散步/.test(text)) {
    tags.push("commute", "walking", "warm");
    energy = energy || 2;
  }

  const context = currentContext();
  if (!tags.length) tags.push(context.segment, "clean");
  return { tags, energy, segment: context.segment };
}

function buildQueue(intent = {}) {
  const picks = recommend(intent, 8).map((track) => track.id);
  const current = state.currentTrackId || picks[0];
  state.queue = uniqueIds([current, ...picks]).slice(0, 8);
}

function createPlan() {
  const slots = [
    { id: "morning", label: "早间", intent: { tags: ["morning", "clean", "fresh"], energy: 2, segment: "morning" } },
    { id: "work", label: "专注", intent: { tags: ["focus", "work", "steady"], energy: 3, segment: "work" } },
    { id: "evening", label: "傍晚", intent: { tags: ["evening", "warm", "commute"], energy: 2, segment: "evening" } },
    { id: "night", label: "夜里", intent: { tags: ["night", "soft", "ambient"], energy: 1, segment: "night" } }
  ];

  state.plan = slots.map((slot) => {
    const tracks = recommend(slot.intent, 3);
    return {
      ...slot,
      trackIds: tracks.map((track) => track.id),
      summary: tracks.map((track) => track.title).join(" / ")
    };
  });

  return state.plan;
}

function getPayload() {
  const context = currentContext();
  const current = getTrack(state.currentTrackId || state.queue?.[0]);
  return {
    context,
    profile,
    current,
    catalog,
    queue: (state.queue || []).map(getTrack),
    history: (state.history || []).map(getTrack),
    messages: state.messages || [],
    likes: state.likes || [],
    dislikes: state.dislikes || [],
    plan: state.plan || createPlan(),
    recommendations: state.recommendations || [],
    lastReason: state.lastReason,
    netease: {
      mode: activeNeteaseMode,
      enabled: true,
      account: {
        loggedIn: Boolean(neteaseSession.profile),
        profile: neteaseSession.profile
      }
    }
  };
}

async function saveAll() {
  await Promise.all([
    saveCatalog(),
    writeJsonIfPossible(profilePath, profile),
    writeJsonIfPossible(statePath, state)
  ]);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function broadcast(event, payload = getPayload()) {
  const text = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sanitizeFileName(value) {
  return String(value || "audio")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 90);
}

function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("missing multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let position = buffer.indexOf(delimiter);

  while (position !== -1) {
    const next = buffer.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;
    let part = buffer.subarray(position + delimiter.length, next);
    if (part.subarray(0, 2).toString() === "--") break;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > -1) {
      const header = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const name = header.match(/name="([^"]+)"/)?.[1];
      const filename = header.match(/filename="([^"]*)"/)?.[1];
      const contentTypeMatch = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1];
      if (name && filename) files[name] = { filename, contentType: contentTypeMatch || "application/octet-stream", buffer: body };
      if (name && !filename) fields[name] = body.toString("utf8");
    }
    position = next;
  }

  return { fields, files };
}

async function handleCatalogUpload(req, res) {
  const contentType = req.headers["content-type"] || "";
  const { fields, files } = parseMultipart(await readBuffer(req), contentType);
  const file = files.audio;
  let audioUrl = String(fields.audioUrl || "").trim();

  if (file?.buffer?.length) {
    if (isReadOnlyRuntime) {
      return sendJson(res, { error: "线上只读环境暂不支持保存本地音频文件，请改用可公开访问的音频链接导入。" }, 503);
    }
    const ext = path.extname(file.filename) || ".mp3";
    const base = sanitizeFileName(`${Date.now()}-${fields.title || path.basename(file.filename, ext)}`);
    const filename = `${base}${ext}`;
    await writeFile(path.join(mediaDir, filename), file.buffer);
    audioUrl = `/media/${filename}`;
  }

  if (!audioUrl) {
    return sendJson(res, { error: "请上传一个音频文件，或填写音频链接。" }, 400);
  }

  const track = upsertTrack({
    title: fields.title,
    artist: fields.artist,
    album: fields.album || "本地导入",
    audioUrl,
    duration: fields.duration || 240,
    source: "manual",
    tags: normalizeTagList(fields.tags || "manual imported")
  });
  state.queue = uniqueIds([track.id, ...(state.queue || [])]).slice(0, 10);
  state.currentTrackId = track.id;
  state.lastReason = `你手动导入了《${track.title}》，我已放进当前队列。`;
  await saveAll();
  broadcast("catalog", getPayload());
  return sendJson(res, { track, payload: getPayload() });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const message = String(body.message || "").trim();
  if (!message) return sendJson(res, { error: "empty message" }, 400);

  state.messages ||= [];
  state.messages.push({ role: "user", text: message, time: nowLabel() });

  let command;
  let aiUsed = false;
  try {
    command = await askDeepSeekForCommand(message);
    aiUsed = Boolean(command);
  } catch (error) {
    console.warn("[DeepSeek]", error.message);
  }
  if (!command) command = localCommandFallback(message);

  const result = await executeDjCommand(command);
  const say = result.say;
  if (aiUsed) state.lastReason = result.reason ? `${result.reason}（DeepSeek 已读懂指令）` : "DeepSeek 已读懂指令。";
  state.messages.push({ role: "codex", text: say, time: nowLabel() });
  await saveAll();
  broadcast("now", getPayload());
  return sendJson(res, {
    say,
    play: state.queue.map(getTrack),
    reason: state.lastReason,
    command,
    aiUsed,
    segue: `接下来从《${getTrack(state.currentTrackId).title}》进入。`,
    payload: getPayload()
  });
}
function buildSay(message, current, picks, context) {
  if (/计划|安排|今天/.test(message)) {
    createPlan();
    return `我把今天分成早间、专注、傍晚和夜里四段。现在是${context.time}，先接《${current.title}》，后面留一点空间给你切换心情。`;
  }
  if (/换|下一首|skip|next/.test(message.toLowerCase())) {
    return `好，换到《${current.title}》。这首会把能量控制在 ${current.energy}/5。`;
  }
  if (/喜欢|收藏|like/.test(message.toLowerCase())) {
    return `记住了。我会把《${current.title}》附近的质感多放一点。`;
  }
  if (/不喜欢|别放|dislike/.test(message.toLowerCase())) {
    return `收到，这类声音先降权。现在换成《${current.title}》。`;
  }
  return `按你刚才的状态，我选《${current.title}》开场。后面会接 ${picks.slice(1, 3).map((track) => `《${track.title}》`).join("、")}。`;
}

function buildReason(intent, current, context) {
  const tags = intent.tags?.slice(0, 3).join("、") || context.segment;
  return `匹配 ${tags}，当前时段是 ${context.segment}，并避开了你的屏蔽标签。`;
}

function addFeedback(trackId, signal) {
  if (!trackId) return;
  state.likes ||= [];
  state.dislikes ||= [];
  if (signal === "like") {
    state.likes = uniqueIds([...state.likes, trackId]);
    state.dislikes = state.dislikes.filter((id) => id !== trackId);
  }
  if (signal === "dislike") {
    state.dislikes = uniqueIds([...state.dislikes, trackId]);
    state.likes = state.likes.filter((id) => id !== trackId);
  }
}

function advanceTrack() {
  const queue = state.queue?.length ? state.queue : recommend({}, 6).map((track) => track.id);
  const current = state.currentTrackId || queue[0];
  state.history = uniqueIds([...(state.history || []), current]).slice(-20);
  const nextQueue = queue.filter((id) => id !== current);
  if (!nextQueue.length) {
    buildQueue(inferIntent(""));
  } else {
    state.currentTrackId = nextQueue[0];
    state.queue = uniqueIds([...nextQueue, ...recommend({}, 4).map((track) => track.id)]).slice(0, 8);
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/now") return sendJson(res, getPayload());
  if (req.method === "GET" && pathname === "/api/catalog") return sendJson(res, { catalog, payload: getPayload() });
  if (req.method === "GET" && pathname === "/api/taste") return sendJson(res, profile);
  if (req.method === "GET" && pathname === "/api/netease/account/status") {
    return sendJson(res, await getNeteaseLoginStatus());
  }
  if (req.method === "POST" && pathname === "/api/netease/account/qr") {
    return sendJson(res, await createNeteaseQrLogin());
  }
  if (req.method === "GET" && pathname === "/api/netease/account/qr/check") {
    const url = new URL(req.url, "http://localhost");
    return sendJson(res, await checkNeteaseQrLogin(url.searchParams.get("key")));
  }
  if (req.method === "POST" && pathname === "/api/netease/account/logout") {
    neteaseSession = { cookie: "", profile: null };
    playlistSongIdCache = { userId: "", expiresAt: 0, ids: new Set() };
    playlistTracksCache.clear();
    audioUrlCache.clear();
    await saveNeteaseSession();
    broadcast("catalog", getPayload());
    return sendJson(res, { loggedIn: false });
  }
  if (req.method === "GET" && pathname === "/api/netease/account/playlists") {
    return sendJson(res, { playlists: await getNeteasePlaylists() });
  }
  if (req.method === "GET" && pathname === "/api/netease/account/playlist") {
    const url = new URL(req.url, "http://localhost");
    const limit = Number(url.searchParams.get("limit") || 40);
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const pageSize = Math.min(500, Math.max(20, limit));
    const songs = await getNeteasePlaylistTracks(url.searchParams.get("id"), { limit: pageSize, offset });
    return sendJson(res, {
      songs,
      limit: pageSize,
      offset,
      nextOffset: offset + songs.length,
      hasMore: songs.length >= pageSize
    });
  }
  if (req.method === "GET" && pathname === "/api/netease/search") {
    const url = new URL(req.url, "http://localhost");
    const query = url.searchParams.get("q") || "";
    const limit = Number(url.searchParams.get("limit") || 12);
    const songs = await searchNetease(query, limit);
    return sendJson(res, { songs, mode: activeNeteaseMode });
  }
  if (req.method === "GET" && pathname === "/api/tts/voices") {
    return sendJson(res, { voices: neuralVoices });
  }
  if (req.method === "POST" && pathname === "/api/tts") return handleTts(req, res);
  if (req.method === "GET" && pathname === "/api/recommendations") {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(12, Math.max(4, Number(url.searchParams.get("limit") || 8)));
    const recommendations = await createRecommendations(limit);
    broadcast("now", getPayload());
    return sendJson(res, { recommendations, payload: getPayload() });
  }
  if (req.method === "GET" && pathname === "/api/plan/today") return sendJson(res, { plan: createPlan(), payload: getPayload() });
  if (req.method === "GET" && pathname === "/api/next") {
    advanceTrack();
    state.lastReason = "手动切歌后，队列会自动补齐相近但不重复的歌。";
    await saveAll();
    broadcast("now", getPayload());
    return sendJson(res, getPayload());
  }
  if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && pathname === "/api/catalog/upload") return handleCatalogUpload(req, res);
  if (req.method === "POST" && pathname === "/api/catalog") {
    const body = await readBody(req);
    const track = upsertTrack({
      ...body,
      source: body.source || "local",
      tags: normalizeTagList(body.tags)
    });
    state.queue = uniqueIds([track.id, ...(state.queue || [])]).slice(0, 10);
    state.lastReason = `已把《${track.title}》加入本地曲库。`;
    await saveAll();
    broadcast("catalog", getPayload());
    return sendJson(res, { track, payload: getPayload() });
  }
  if (req.method === "POST" && pathname === "/api/netease/play") {
    const body = await readBody(req);
    try {
      const track = await playNeteaseSong(body.song || body, null);
      return sendJson(res, { track, payload: getPayload() });
    } catch (error) {
      return sendJson(res, {
        error: "这首歌暂时拿不到可播放链接",
        reason: error.message || "网易云没有给当前账号返回可播放链接。",
        code: "NETEASE_NO_PLAYABLE_URL"
      }, error.status || 422);
    }
  }
  if (req.method === "POST" && pathname === "/api/netease/account/play") {
    const body = await readBody(req);
    try {
      const song = body.song || body;
      const track = await playNeteaseSong(song, `正在播放你网易云账号里的《${song.title || song.name || "这首歌"}》。`);
      return sendJson(res, { track, payload: getPayload() });
    } catch (error) {
      return sendJson(res, {
        error: "这首歌暂时拿不到可播放链接",
        reason: error.message || "网易云没有给当前账号返回可播放链接。",
        code: "NETEASE_NO_PLAYABLE_URL"
      }, error.status || 422);
    }
  }
  if (req.method === "POST" && pathname === "/api/netease/import") {
    const body = await readBody(req);
    const baseTrack = normalizeTrack({
      ...(body.song || body),
      source: "netease"
    });
    const resolved = await resolveNeteaseAudio(baseTrack);
    baseTrack.audioUrl = resolved.source === "outer-url-fallback" ? "" : resolved.url;
    const track = upsertTrack(baseTrack);
    state.queue = uniqueIds([track.id, ...(state.queue || [])]).slice(0, 10);
    state.currentTrackId = body.playNow ? track.id : state.currentTrackId;
    state.lastReason = `已从网易云音乐导入《${track.title}》，可以直接加入电台队列。`;
    await saveAll();
    broadcast("catalog", getPayload());
    return sendJson(res, { track, payload: getPayload() });
  }
  if (req.method === "POST" && pathname === "/api/play") {
    const body = await readBody(req);
    let track = getTrack(String(body.trackId || ""));
    try {
      track = await refreshNeteaseTrackAudio(track);
    } catch (error) {
      return sendJson(res, {
        error: "这首歌暂时拿不到可播放链接",
        reason: error.message || "网易云没有给当前账号返回可播放链接。",
        code: "NETEASE_NO_PLAYABLE_URL"
      }, error.status || 422);
    }
    const requestedPlaylist = Array.isArray(body.playlist)
      ? uniqueIds(body.playlist.map(String).filter((id) => catalog.some((item) => item.id === id)))
      : [];
    state.currentTrackId = track.id;
    if (requestedPlaylist.includes(track.id)) {
      const currentIndex = requestedPlaylist.indexOf(track.id);
      state.queue = [...requestedPlaylist.slice(currentIndex), ...requestedPlaylist.slice(0, currentIndex)];
    } else {
      state.queue = uniqueIds([track.id, ...(state.queue || []), ...recommend(inferIntent(""), 4).map((item) => item.id)]).slice(0, 8);
    }
    state.lastReason = `你点选了《${track.title}》，队列会围绕它继续补歌。`;
    await saveAll();
    broadcast("now", getPayload());
    return sendJson(res, getPayload());
  }
  if (req.method === "POST" && pathname === "/api/taste") {
    const body = await readBody(req);
    profile = { ...profile, ...body };
    buildQueue(inferIntent(""));
    await saveAll();
    broadcast("profile", getPayload());
    return sendJson(res, getPayload());
  }
  if (req.method === "POST" && pathname === "/api/feedback") {
    const body = await readBody(req);
    addFeedback(String(body.trackId || state.currentTrackId), body.signal);
    await saveAll();
    broadcast("feedback", getPayload());
    return sendJson(res, getPayload());
  }
  return sendJson(res, { error: "not found" }, 404);
}

function handleStream(req, res) {
  if (isVercel) {
    res.writeHead(204, {
      "Cache-Control": "no-store",
      Connection: "close"
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  res.write(`event: now\ndata: ${JSON.stringify(getPayload())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function isAppRoute(pathname) {
  return ["/", "/profile", "/library", "/settings"].includes(pathname);
}

function cacheHeaderFor(ext) {
  if (ext === ".html") return "no-store";
  if ([".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  let filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let ext = path.extname(filePath);
  try {
    await stat(filePath);
  } catch {
    if (!isAppRoute(pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    filePath = path.join(publicDir, "index.html");
    ext = ".html";
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": cacheHeaderFor(ext)
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/stream") return handleStream(req, res);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message }, 500);
  }
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < 8090) {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, () => {
    console.log(`Codex Radio is running at http://localhost:${port}`);
  });
}

export default function handler(req, res) {
  server.emit("request", req, res);
}

await startManagedNeteaseApi();
buildQueue(inferIntent(""));
await saveAll();
if (!isVercel) listen(Number(process.env.PORT || 8080));
