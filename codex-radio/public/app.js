const qs = (selector, scope = document) => scope.querySelector(selector);
const qsa = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const tagOptions = [
  "focus", "calm", "clean", "warm", "electronic", "morning", "night", "ambient",
  "soft", "bright", "uplift", "commute", "reading", "work", "rain", "fast",
  "netease", "imported", "live"
];

const tagLabels = {
  focus: "专注",
  calm: "平静",
  clean: "清爽",
  warm: "温暖",
  electronic: "电子",
  morning: "早晨",
  night: "夜晚",
  ambient: "氛围",
  soft: "柔和",
  bright: "明亮",
  uplift: "提神",
  commute: "通勤",
  reading: "阅读",
  work: "工作",
  rain: "雨天",
  fast: "快节奏",
  netease: "网易云",
  imported: "导入",
  live: "现场"
};

function tagLabel(tag) {
  return displayTagLabels[tag] || tagLabels[tag] || tag;
}

const displayTagLabels = {
  focus: "专注",
  calm: "平静",
  clean: "清爽",
  warm: "温暖",
  electronic: "电子",
  morning: "清晨",
  night: "夜晚",
  ambient: "氛围",
  soft: "柔和",
  bright: "明亮",
  uplift: "提神",
  commute: "通勤",
  reading: "阅读",
  work: "工作",
  rain: "雨天",
  fast: "快节奏",
  netease: "网易云",
  imported: "导入",
  live: "现场"
};

const tagTones = {
  electronic: "neon",
  ambient: "neon",
  focus: "blue",
  work: "blue",
  reading: "blue",
  clean: "aqua",
  calm: "aqua",
  rain: "aqua",
  warm: "gold",
  morning: "gold",
  bright: "gold",
  uplift: "coral",
  commute: "coral",
  fast: "coral",
  soft: "mint",
  night: "violet",
  netease: "mint",
  imported: "mint",
  live: "coral"
};

function tagTone(tag) {
  return tagTones[tag] || "aqua";
}

const app = {
  state: null,
  playing: false,
  audio: null,
  media: null,
  mediaToken: 0,
  mediaTrackKey: "",
  nodes: [],
  analyser: null,
  animation: null,
  eventSource: null,
  neteaseResults: [],
  neteaseUserId: "",
  accountPlaylists: [],
  accountSongs: [],
  accountPlaylistId: "",
  accountSongsHasMore: false,
  accountSongsLoading: false,
  accountSongsSyncing: false,
  accountSongsNextOffset: 0,
  accountPageSize: 40,
  recommendations: [],
  playlist: [],
  currentIndex: -1,
  playlistMode: "queue",
  particleCover: null,
  seeking: false,
  progressTrackKey: "",
  progressDuration: 0,
  qrKey: "",
  qrTimer: null,
  voices: [],
  ttsVoices: [],
  speechMedia: null
};

const CACHE_VERSION = "v3";
const ACCOUNT_CACHE_PREFIX = `codex-radio:${CACHE_VERSION}:netease`;
const USER_SESSION_CACHE_KEY = `codex-radio:${CACHE_VERSION}:user-session`;
const ACCOUNT_SYNC_INTERVAL = 8 * 60 * 1000;

function readLocalCache(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeLocalCache(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function trackIds(tracks = []) {
  return (tracks || []).map((track) => track?.id).filter(Boolean);
}

function portableSessionState(payload) {
  if (!payload) return null;
  return {
    profile: payload.profile || null,
    state: {
      currentTrackId: payload.current?.id || "",
      queue: trackIds(payload.queue),
      history: trackIds(payload.history),
      messages: Array.isArray(payload.messages) ? payload.messages.slice(-80) : [],
      likes: Array.isArray(payload.likes) ? payload.likes : [],
      dislikes: Array.isArray(payload.dislikes) ? payload.dislikes : [],
      plan: payload.plan || null,
      recommendations: Array.isArray(payload.recommendations) ? payload.recommendations.slice(0, 24) : [],
      lastReason: payload.lastReason || ""
    },
    savedAt: Date.now()
  };
}

function saveUserSessionSnapshot(payload = app.state) {
  const snapshot = portableSessionState(payload);
  if (snapshot) writeLocalCache(USER_SESSION_CACHE_KEY, snapshot);
}

async function restoreUserSessionSnapshot() {
  const snapshot = readLocalCache(USER_SESSION_CACHE_KEY);
  if (!snapshot?.profile && !snapshot?.state) return null;
  try {
    const payload = await api("/api/session/restore", {
      method: "POST",
      body: JSON.stringify(snapshot)
    });
    render(payload);
    return payload;
  } catch {
    return null;
  }
}

function neteaseCacheScope() {
  return String(app.neteaseUserId || app.state?.netease?.account?.profile?.userId || "default");
}

function accountCacheKey(name) {
  return `${ACCOUNT_CACHE_PREFIX}:${neteaseCacheScope()}:${name}`;
}

function playlistSongsCacheKey(playlistId) {
  return accountCacheKey(`playlist:${playlistId}:songs`);
}

function lastPlaylistCacheKey() {
  return accountCacheKey("last-playlist");
}

function playlistListCacheKey() {
  return accountCacheKey("playlists");
}

function cachePayload(value) {
  return { ...value, cachedAt: Date.now() };
}

async function clearOldCaches() {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const error = new Error(parsed.reason || parsed.error || text);
      error.payload = parsed;
      throw error;
    } catch (error) {
      if (error.payload) throw error;
      throw new Error(text);
    }
  }
  return response.json();
}

async function apiForm(path, formData) {
  const response = await fetch(path, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const error = new Error(parsed.reason || parsed.error || text);
      error.payload = parsed;
      throw error;
    } catch (error) {
      if (error.payload) throw error;
      throw new Error(text);
    }
  }
  return response.json();
}

function setIcon(iconName) {
  const playButton = qs("#playButton");
  playButton.innerHTML = `<i data-lucide="${iconName}"></i>`;
  refreshIcons();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function findSelectedVoice(name) {
  return app.voices.find((voice) => voice.name === name) || null;
}

function findSelectedTtsVoice(id) {
  return app.ttsVoices.find((voice) => voice.id === id) || null;
}

function updateVoiceLabel(enabled = qs("#voiceEnabled")?.checked, voice = findSelectedVoice(qs("#voiceSelect")?.value)) {
  const label = qs("#voiceLabel");
  if (!label) return;
  const mode = qs("#voiceMode")?.value || app.state?.profile?.voiceMode || "neural";
  if (!enabled) {
    label.textContent = "静音";
    return;
  }
  if (mode === "neural") {
    const selected = findSelectedTtsVoice(qs("#neuralVoiceSelect")?.value || app.state?.profile?.neuralVoice);
    label.textContent = selected ? `真人语音 · ${selected.name}` : "真人语音";
    return;
  }
  if (!enabled) {
    label.textContent = "静音";
    return;
  }
  label.textContent = voice ? `${voice.name} · ${voice.lang || "系统"}` : "跟随系统";
}

async function loadTtsVoices() {
  const select = qs("#neuralVoiceSelect");
  if (!select) return;
  try {
    const result = await api("/api/tts/voices");
    app.ttsVoices = result.voices || [];
  } catch {
    app.ttsVoices = [];
  }
  const currentValue = app.state?.profile?.neuralVoice || select.value || "zh-CN-XiaoxiaoNeural";
  select.innerHTML = app.ttsVoices.map((voice) => (
    `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name)} · ${voice.gender === "male" ? "男声" : "女声"}</option>`
  )).join("");
  if (app.ttsVoices.some((voice) => voice.id === currentValue)) {
    select.value = currentValue;
  }
  updateVoiceLabel();
}

function loadVoices() {
  if (!window.speechSynthesis) return;
  app.voices = window.speechSynthesis.getVoices();
  const select = qs("#voiceSelect");
  if (!select) return;

  const currentValue = app.state?.profile?.voiceName || select.value || "";
  const chineseVoice = (voice) => /zh|cmn|yue|mandarin|chinese|中文|普通话|粤语/i.test(`${voice.lang} ${voice.name}`);
  const voices = [...app.voices].sort((a, b) => {
    const group = Number(!chineseVoice(a)) - Number(!chineseVoice(b));
    if (group) return group;
    return a.name.localeCompare(b.name);
  });

  select.innerHTML = [
    `<option value="">跟随系统</option>`,
    ...voices.map((voice) => (
      `<option value="${escapeHtml(voice.name)}">${escapeHtml(voice.name)}${voice.lang ? ` · ${escapeHtml(voice.lang)}` : ""}</option>`
    ))
  ].join("");

  if (currentValue && voices.some((voice) => voice.name === currentValue)) {
    select.value = currentValue;
  }
  updateVoiceLabel();
}

function formatDuration(seconds = 0) {
  return formatClock(seconds);
}

function formatClock(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function trackDuration(track) {
  return Math.max(0, Number(track?.duration) || 0);
}

function setProgressDuration(seconds) {
  app.progressDuration = Math.max(0, Number(seconds) || 0);
  const duration = qs("#durationTime");
  if (duration) duration.textContent = formatClock(app.progressDuration);
}

function updateProgress(current = app.media?.currentTime || 0) {
  const progress = qs("#progressRange");
  const currentTime = qs("#currentTime");
  const value = Math.max(0, Number(current) || 0);
  const duration = app.progressDuration || trackDuration(app.state?.current);
  const ratio = duration > 0 ? Math.min(1, value / duration) : 0;
  if (currentTime) currentTime.textContent = formatClock(value);
  if (progress && !app.seeking) progress.value = String(Math.round(ratio * 1000));
  if (progress) progress.style.setProperty("--progress", `${ratio * 100}%`);
}

function resetProgressForTrack(track) {
  app.progressTrackKey = trackKey(track);
  setProgressDuration(trackDuration(track));
  app.seeking = false;
  updateProgress(0);
}

function seekToRatio(ratio) {
  if (!app.media) return;
  const duration = Number.isFinite(app.media.duration) && app.media.duration > 0
    ? app.media.duration
    : app.progressDuration;
  if (!duration) return;
  const target = Math.max(0, Math.min(1, Number(ratio) || 0)) * duration;
  app.media.currentTime = target;
  updateProgress(target);
}

function trackKey(track) {
  if (!track) return "";
  if (track.neteaseId) return `netease:${track.neteaseId}`;
  if (track.id) return `id:${track.id}`;
  return `meta:${track.title || ""}|${track.artist || ""}|${track.album || ""}`;
}

function sameTrack(a, b) {
  const aKey = trackKey(a);
  const bKey = trackKey(b);
  return Boolean(aKey && bKey && aKey === bKey);
}

function findPlaylistIndex(track, list = app.playlist) {
  if (!track) return -1;
  return list.findIndex((item) => sameTrack(item, track));
}

function setPlaylist(tracks = [], currentTrack = null, mode = "queue") {
  const seen = new Set();
  const list = [];
  for (const track of tracks.filter(Boolean)) {
    const key = trackKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(track);
  }
  if (!list.length) return app.playlist;
  app.playlist = list;
  app.playlistMode = mode;
  const selectedIndex = findPlaylistIndex(currentTrack, list);
  app.currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return app.playlist;
}

function syncPlaylistFromPayload(payload) {
  if (!payload) return;
  if (payload.current && findPlaylistIndex(payload.current) >= 0) {
    app.currentIndex = findPlaylistIndex(payload.current);
    return;
  }
  if (payload.queue?.length) setPlaylist(payload.queue, payload.current, "queue");
}

function playlistIds() {
  return app.playlist.map((track) => track.id).filter(Boolean);
}

function isKnownCatalogTrack(track) {
  if (!track?.id) return false;
  return Boolean((app.state?.catalog || []).some((item) => item.id === track.id));
}

function setConnection(online) {
  qs("#connectionDot").classList.toggle("is-online", online);
  qs("#connectionText").textContent = online ? "已连接" : "离线";
}

function render(payload = app.state) {
  if (!payload) return;
  app.state = payload;
  saveUserSessionSnapshot(payload);
  syncPlaylistFromPayload(payload);
  const { current, context, profile, queue, messages, plan, recommendations, lastReason, catalog, netease } = payload;
  const name = profile.name || "你";

  qs("#contextLabel").textContent = `${context.city} · ${context.weather} · ${context.time}`;
  qs("#headline").textContent = `${name}的 Codex 首页`;
  qs("#segmentPill").textContent = context.segment;
  qs("#trackTitle").textContent = current.title;
  qs("#trackTitle").dataset.echo = current.title;
  qs("#trackArtist").textContent = `${current.artist} · ${current.album}`;
  qs("#coverMood").textContent = tagLabel(current.mood);
  qs("#coverBpm").textContent = `${current.bpm} BPM`;
  qs("#reasonLine").textContent = lastReason || "";

  const cover = qs("#coverArt");
  cover.style.setProperty("--cover-a", current.colors?.[0] || "#26394f");
  cover.style.setProperty("--cover-b", current.colors?.[1] || "#d0a85b");
  cover.style.setProperty("--cover-c", current.colors?.[2] || "#5f8fc8");
  updateAlbumCover(current);
  const currentKey = trackKey(current);
  const mediaIsPlayingDifferentTrack = Boolean(app.media?.src && app.mediaTrackKey && app.mediaTrackKey !== currentKey);
  if (mediaIsPlayingDifferentTrack) {
    updateProgress(app.media.currentTime || 0);
  } else if (app.progressTrackKey !== currentKey) {
    resetProgressForTrack(current);
  } else if (!app.media) {
    setProgressDuration(trackDuration(current));
    updateProgress(0);
  }

  qs("#trackTags").innerHTML = current.tags.map((tag) => `<span class="tag">${tagLabel(tag)}</span>`).join("");
  renderQueue(queue || [], current);
  renderMessages(messages || []);
  renderRecommendations(recommendations || plan || []);
  renderCatalog(catalog || [], current.id);
  qs("#neteaseMode").textContent = netease?.mode || "public";
  renderNeteaseAccount(netease?.account);
  fillProfile(profile);
  drawIdle();
  refreshIcons();
}

function renderQueue(queue, currentTrack) {
  qs("#queueList").innerHTML = queue.map((track, index) => `
    <button class="queue-item ${sameTrack(track, currentTrack) ? "is-current" : ""}" type="button" data-track-id="${track.id}" data-track-index="${index}">
      <span class="mini-cover" style="--a:${track.colors[0]};--b:${track.colors[1]};--c:${track.colors[2]}"></span>
      <span class="queue-copy">
        <strong>${track.title}</strong>
        <span>${track.artist}</span>
      </span>
      <em>${formatDuration(track.duration)}</em>
    </button>
  `).join("");
}

function renderMessages(messages) {
  const el = qs("#messages");
  el.innerHTML = messages.map((message) => `
    <div class="message ${message.role === "user" ? "user" : "codex"}">
      ${escapeHtml(message.text)}
    </div>
  `).join("");
  el.scrollTop = el.scrollHeight;
}

function renderRecommendations(recommendations) {
  const list = qs("#planList");
  app.recommendations = recommendations.filter((item) => item.title);
  if (!app.recommendations.length) {
    list.innerHTML = `<div class="empty-state compact">点击刷新，随机发现你歌单外可能喜欢的歌。</div>`;
    return;
  }
  list.innerHTML = app.recommendations.map((track, index) => `
    <button class="plan-item recommendation-item" type="button" data-play-recommendation="${index}">
      <span class="mini-cover" style="--a:${track.colors?.[0] || "#26394f"};--b:${track.colors?.[1] || "#d0a85b"};--c:${track.colors?.[2] || "#5f8fc8"}"></span>
      <span class="queue-copy">
        <strong>${escapeHtml(track.title)}</strong>
        <span>${escapeHtml(track.artist)} · ${escapeHtml(track.recommendationSource || "歌单外推荐")}</span>
      </span>
      <i data-lucide="play"></i>
    </button>
  `).join("");
  refreshIcons();
}

function renderCatalog(catalog, currentId) {
  const list = qs("#catalogList");
  if (!list) return;
  list.innerHTML = catalog.map((track) => `
    <div class="source-item ${track.id === currentId ? "is-current" : ""}">
      <span class="mini-cover" style="--a:${track.colors?.[0] || "#26394f"};--b:${track.colors?.[1] || "#d0a85b"};--c:${track.colors?.[2] || "#5f8fc8"}"></span>
      <span class="source-copy">
        <strong>${escapeHtml(track.title)}</strong>
        <span>${escapeHtml(track.artist)} · ${escapeHtml(track.album || "本地曲库")}</span>
      </span>
      <span class="source-meta">${track.source === "netease" ? "网易云" : "本地"}</span>
      <button class="icon-button" type="button" data-play-track="${track.id}" title="播放">
        <i data-lucide="play"></i>
      </button>
    </div>
  `).join("");
}

function renderNeteaseResults(songs) {
  const list = qs("#neteaseResults");
  if (!list) return;
  if (!songs.length) {
    list.innerHTML = `<div class="empty-state">搜索网易云后，可以把结果导入本地曲库。</div>`;
    return;
  }
  list.innerHTML = songs.map((song, index) => `
    <div class="source-item">
      <span class="mini-cover" style="--a:${song.colors?.[0] || "#26394f"};--b:${song.colors?.[1] || "#d0a85b"};--c:${song.colors?.[2] || "#5f8fc8"}"></span>
      <span class="source-copy">
        <strong>${escapeHtml(song.title)}</strong>
        <span>${escapeHtml(song.artist)} · ${escapeHtml(song.album || "网易云音乐")}</span>
      </span>
      <span class="source-meta">${formatDuration(song.duration)}</span>
      <button class="tool-button" type="button" data-play-netease-result="${index}">
        <i data-lucide="play"></i>
        <span>播放</span>
      </button>
      <button class="tool-button" type="button" data-import-netease="${index}">
        <i data-lucide="plus"></i>
        <span>导入</span>
      </button>
    </div>
  `).join("");
  refreshIcons();
}

function renderNeteaseAccount(account) {
  const status = qs("#neteaseAccountStatus");
  if (!status) return;
  if (account?.loggedIn && account.profile) {
    app.neteaseUserId = String(account.profile.userId || "");
    status.innerHTML = `
      <div class="account-card">
        ${account.profile.avatarUrl ? `<img src="${account.profile.avatarUrl}" alt="">` : `<span class="brand-mark">NE</span>`}
        <div>
          <strong>${escapeHtml(account.profile.nickname || "网易云账号")}</strong>
          <span>已连接网易云账号</span>
        </div>
      </div>
    `;
    qs("#loadPlaylistsButton").disabled = false;
    qs("#neteaseLogoutButton").disabled = false;
  } else {
    status.innerHTML = `<div class="empty-state compact">未连接账号。点击“扫码登录”，用网易云音乐 App 扫码确认。</div>`;
    qs("#loadPlaylistsButton").disabled = true;
    qs("#neteaseLogoutButton").disabled = true;
  }
}

function compactSongs(songs = []) {
  const seen = new Set();
  const compact = [];
  for (const song of songs.filter(Boolean)) {
    const key = trackKey(song);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    compact.push(song);
  }
  return compact;
}

function mergeSongPage(existing = [], incoming = [], offset = 0) {
  const next = existing.slice();
  for (let index = 0; index < incoming.length; index += 1) {
    next[offset + index] = incoming[index];
  }
  return compactSongs(next);
}

function similarJson(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function savePlaylistSongsCache(playlistId) {
  if (!playlistId) return;
  writeLocalCache(playlistSongsCacheKey(playlistId), cachePayload({
    playlistId,
    songs: compactSongs(app.accountSongs),
    hasMore: app.accountSongsHasMore,
    nextOffset: app.accountSongsNextOffset
  }));
}

function readPlaylistSongsCache(playlistId) {
  const cached = readLocalCache(playlistSongsCacheKey(playlistId));
  if (!cached?.songs?.length) return null;
  return {
    ...cached,
    songs: compactSongs(cached.songs),
    nextOffset: Number(cached.nextOffset || cached.songs.length)
  };
}

function renderPlaylists(playlists) {
  const list = qs("#accountPlaylists");
  app.accountPlaylists = playlists || [];
  if (!playlists.length) {
    list.innerHTML = `<div class="empty-state compact">没有读取到歌单。</div>`;
    return;
  }
  list.innerHTML = playlists.map((playlist) => `
    <button class="playlist-item ${String(playlist.id) === String(app.accountPlaylistId) ? "is-selected" : ""}" type="button" data-playlist-id="${playlist.id}">
      ${playlist.coverImgUrl ? `<img src="${playlist.coverImgUrl}" alt="">` : `<span class="mini-cover" style="--a:#26394f;--b:#d0a85b;--c:#5f8fc8"></span>`}
      <span>
        <strong>${escapeHtml(playlist.name)}</strong>
        <em>${playlist.trackCount || 0} 首 · ${escapeHtml(playlist.creator || "")}</em>
      </span>
    </button>
  `).join("");
}

function renderAccountSongs(songs = app.accountSongs) {
  const list = qs("#accountSongs");
  app.accountSongs = compactSongs(songs);
  const footer = app.accountPlaylistId ? `
    <div class="account-load-state">
      ${app.accountSongsLoading ? "正在继续载入..." : app.accountSongsSyncing ? "正在后台同步..." : app.accountSongsHasMore ? "向下滚动自动载入更多" : app.accountSongs.length ? `已载入 ${app.accountSongs.length} 首` : ""}
      ${app.accountSongsHasMore && !app.accountSongsLoading ? `<button class="tool-button" type="button" data-load-more-account><i data-lucide="chevrons-down"></i><span>继续载入</span></button>` : ""}
    </div>
  ` : "";
  if (!app.accountSongs.length) {
    list.innerHTML = app.accountPlaylistId
      ? `<div class="empty-state compact">${app.accountSongsLoading ? "正在读取歌单歌曲..." : "这个歌单暂时没有可显示的歌曲。"}</div>${footer}`
      : `<div class="empty-state compact">选择一个歌单后，这里会显示歌曲。</div>`;
    refreshIcons();
    return;
  }
  list.innerHTML = app.accountSongs.map((song, index) => `
    <div class="source-item ${sameTrack(song, app.state?.current) ? "is-current" : ""}">
      <span class="mini-cover" style="--a:${song.colors?.[0] || "#26394f"};--b:${song.colors?.[1] || "#d0a85b"};--c:${song.colors?.[2] || "#5f8fc8"}"></span>
      <span class="source-copy">
        <strong>${escapeHtml(song.title)}</strong>
        <span>${escapeHtml(song.artist)} · ${escapeHtml(song.album || "网易云音乐")}</span>
      </span>
      <span class="source-meta">${formatDuration(song.duration)}</span>
      <button class="tool-button" type="button" data-play-account-song="${index}">
        <i data-lucide="play"></i>
        <span>播放</span>
      </button>
    </div>
  `).join("") + footer;
  refreshIcons();
  return;
  app.accountSongs = songs;
  if (!songs.length) {
    list.innerHTML = `<div class="empty-state compact">选择一个歌单后，这里会显示歌曲。</div>`;
    return;
  }
  list.innerHTML = songs.map((song, index) => `
    <div class="source-item">
      <span class="mini-cover" style="--a:${song.colors?.[0] || "#26394f"};--b:${song.colors?.[1] || "#d0a85b"};--c:${song.colors?.[2] || "#5f8fc8"}"></span>
      <span class="source-copy">
        <strong>${escapeHtml(song.title)}</strong>
        <span>${escapeHtml(song.artist)} · ${escapeHtml(song.album || "网易云音乐")}</span>
      </span>
      <span class="source-meta">${formatDuration(song.duration)}</span>
      <button class="tool-button" type="button" data-play-account-song="${index}">
        <i data-lucide="play"></i>
        <span>播放</span>
      </button>
    </div>
  `).join("");
  refreshIcons();
}

function fillProfile(profile) {
  qs("#profileName").value = profile.name || "";
  qs("#profileCity").value = profile.city || "";
  qs("#voiceEnabled").checked = Boolean(profile.voiceEnabled);
  qs("#crossfade").value = profile.crossfade ?? 6;
  qs("#voiceMode").value = profile.voiceMode || "neural";
  qs("#voiceLabel").textContent = profile.voiceEnabled ? "系统语音" : "静音";
  qs("#voiceRate").value = profile.voiceRate ?? 0.96;
  qs("#voicePitch").value = profile.voicePitch ?? 0.9;
  loadVoices();
  loadTtsVoices().then(() => {
    qs("#neuralVoiceSelect").value = profile.neuralVoice || "zh-CN-XiaoxiaoNeural";
    updateVoiceLabel(profile.voiceEnabled, findSelectedVoice(profile.voiceName));
  });
  qs("#voiceSelect").value = profile.voiceName || "";
  updateVoiceLabel(profile.voiceEnabled, findSelectedVoice(profile.voiceName));
  qs("#routineMorning").value = profile.routines?.morning || "";
  qs("#routineWork").value = profile.routines?.work || "";
  qs("#routineEvening").value = profile.routines?.evening || "";
  qs("#routineNight").value = profile.routines?.night || "";
  renderTagEditor("preferredTags", profile.preferredTags || [], "is-selected");
  renderTagEditor("blockedTags", profile.blockedTags || [], "is-blocked");
}

function renderTagEditor(id, selected, className) {
  const selectedSet = new Set(selected);
  qs(`#${id}`).innerHTML = tagOptions.map((tag) => `
    <button class="tag-choice tag-tone-${tagTone(tag)} ${selectedSet.has(tag) ? className : ""}" type="button" data-tag="${tag}">
      ${tagLabel(tag)}
    </button>
  `).join("");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadNow() {
  try {
    render(await api("/api/now"));
    setConnection(true);
  } catch (error) {
    setConnection(false);
    toast("本地服务没有响应");
  }
}

function openStream() {
  if (!window.EventSource) return;
  app.eventSource = new EventSource("/stream");
  app.eventSource.addEventListener("now", (event) => {
    render(JSON.parse(event.data));
    setConnection(true);
  });
  app.eventSource.addEventListener("profile", (event) => render(JSON.parse(event.data)));
  app.eventSource.addEventListener("catalog", (event) => render(JSON.parse(event.data)));
  app.eventSource.onerror = () => setConnection(false);
}

function ensureAudio() {
  if (!app.audio) {
    app.audio = new AudioContext();
  }
  if (app.audio.state === "suspended") app.audio.resume();
}

function ensureMediaElement() {
  if (!app.media) {
    app.media = new Audio();
    app.media.preload = "auto";
    app.media.autoplay = false;
  }
  return app.media;
}

function resumeMediaFromCurrentTime() {
  if (!app.media || !app.media.src || app.media.ended) return false;
  app.playing = true;
  setIcon("pause");
  app.media.play().then(() => {
    app.playing = true;
    setIcon("pause");
  }).catch(() => {
    app.playing = false;
    setIcon("play");
    toast("浏览器拦截了播放，请再点一次播放");
  });
  startParticleCover();
  return true;
}

function stopNodes({ keepMedia = false } = {}) {
  app.analyser = null;
  if (app.media && !keepMedia) {
    app.media.pause();
    app.mediaToken += 1;
    app.mediaTrackKey = "";
    app.media.removeAttribute("src");
    app.media.load();
  }
  for (const node of app.nodes) {
    try {
      node.stop();
    } catch {}
    try {
      node.disconnect();
    } catch {}
  }
  app.nodes = [];
}

function startTrack(track) {
  if (!track || !app.playing) return;
  if (track.audioUrl) {
    startMediaTrack(track);
    return;
  }
  stopNodes();
  app.playing = false;
  setIcon("play");
  drawIdle();
  toast("这首歌没有真实音频。请手动导入音频文件，或连接网易云账号后播放账号里的歌。");
}

function startMediaTrack(track) {
  const key = trackKey(track);
  const media = ensureMediaElement();
  if (app.mediaTrackKey === key && media.src && !media.ended) {
    resumeMediaFromCurrentTime();
    return;
  }

  stopNodes({ keepMedia: true });
  media.pause();
  app.mediaToken += 1;
  app.mediaTrackKey = key;
  const token = app.mediaToken;
  const isCurrentMedia = () => app.media === media && app.mediaToken === token;
  media.preload = "auto";
  media.autoplay = true;
  resetProgressForTrack(track);
  const syncDuration = () => {
    if (!isCurrentMedia()) return;
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : trackDuration(track);
    setProgressDuration(duration);
    if (!app.seeking) updateProgress(media.currentTime || 0);
  };
  media.onloadedmetadata = syncDuration;
  media.ondurationchange = syncDuration;
  media.ontimeupdate = () => {
    if (!isCurrentMedia() || app.seeking) return;
    updateProgress(media.currentTime || 0);
  };
  media.onended = () => {
    if (!isCurrentMedia()) return;
    app.seeking = false;
    updateProgress(app.progressDuration || media.duration || 0);
    handleTrackEnded();
  };
  media.onerror = () => {
    if (!isCurrentMedia()) return;
    app.playing = false;
    setIcon("play");
    stopNodes();
    toast("这首歌暂时拿不到可播放链接。换一首，或用本地音频文件手动导入。");
  };
  media.src = track.audioUrl;
  media.load();
  media.play().then(() => {
    if (!isCurrentMedia()) return;
    app.playing = true;
    setIcon("pause");
  }).catch(() => {
    if (!isCurrentMedia()) return;
    app.playing = false;
    setIcon("play");
    toast("浏览器拦截了播放，请再点一次播放");
  });
  animateMockVisualizer();
}

function togglePlay() {
  const current = app.state?.current || app.playlist[app.currentIndex];
  if (app.playing) {
    app.playing = false;
    setIcon("play");
    if (app.media) app.media.pause();
    else stopNodes();
    return;
  }

  app.playing = true;
  setIcon("pause");
  if (resumeMediaFromCurrentTime()) return;
  if (false && app.media && app.progressTrackKey === trackKey(current) && !app.media.ended) {
    app.media.play().catch(() => {
      toast("Playback was blocked. Tap play again.");
      /*
      toast("娴忚鍣ㄦ嫤鎴簡鎾斁锛岃鍐嶇偣涓€娆℃挱鏀?);
      */
    });
    startParticleCover();
  } else {
    startTrack(current);
  }
}

async function speak(text) {
  if (!text || !app.state?.profile?.voiceEnabled) return;
  const { profile } = app.state;
  if (app.speechMedia) {
    app.speechMedia.pause();
    app.speechMedia = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  if ((profile.voiceMode || "neural") === "neural") {
    try {
      const result = await api("/api/tts", {
        method: "POST",
        body: JSON.stringify({
          text,
          voice: profile.neuralVoice,
          rate: profile.voiceRate,
          pitch: profile.voicePitch
        })
      });
      app.speechMedia = new Audio(result.audioUrl);
      app.speechMedia.volume = 0.92;
      await app.speechMedia.play();
      return;
    } catch {
      toast("真人语音暂时不可用，已切回系统语音");
    }
  }

  speakWithSystemVoice(text, profile);
}

function speakWithSystemVoice(text, profile) {
  if (!window.speechSynthesis) return;
  if (!app.voices.length) loadVoices();
  const voice = findSelectedVoice(profile.voiceName);
  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || "zh-CN";
  utterance.rate = clampNumber(profile.voiceRate, 0.7, 1.3, 0.96);
  utterance.pitch = clampNumber(profile.voicePitch, 0.7, 1.3, 0.9);
  window.speechSynthesis.speak(utterance);
}

function albumCoverUrl(track) {
  return track?.coverUrl || track?.picUrl || track?.albumPicUrl || track?.coverImgUrl || "";
}

function cssImageUrl(url) {
  return `url("${String(url).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`;
}

function hslFromColor(color, fallbackHue = 210) {
  const value = String(color || "").trim();
  const hsl = value.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
  if (hsl) {
    return { h: Number(hsl[1]), s: Number(hsl[2]), l: Number(hsl[3]) };
  }
  const hex = value.match(/^#?([0-9a-f]{6})$/i);
  if (!hex) return { h: fallbackHue, s: 74, l: 62 };

  const number = Number.parseInt(hex[1], 16);
  const r = ((number >> 16) & 255) / 255;
  const g = ((number >> 8) & 255) / 255;
  const b = (number & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { h: fallbackHue, s: 0, l: lightness * 100 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function coverPalette(track) {
  const colors = (track?.colors || []).filter(Boolean);
  const palette = colors.map((color, index) => hslFromColor(color, 190 + index * 54));
  return palette.length ? palette : [
    { h: 205, s: 82, l: 62 },
    { h: 286, s: 72, l: 66 },
    { h: 164, s: 70, l: 58 }
  ];
}

function fallbackCoverAnalysis(track) {
  const palette = coverPalette(track);
  const brightness = palette.reduce((sum, color) => sum + color.l, 0) / Math.max(1, palette.length) / 100;
  const saturation = palette.reduce((sum, color) => sum + color.s, 0) / Math.max(1, palette.length) / 100;
  const contrast = 0.34 + Math.abs(brightness - 0.5) * 0.35;
  return {
    palette,
    brightness,
    saturation,
    contrast,
    density: 0.86 + (1 - brightness) * 0.34 + contrast * 0.22,
    glow: 0.72 + brightness * 0.46 + saturation * 0.34,
    spread: 0.82 + brightness * 0.32 - contrast * 0.12,
    intensity: 0.72 + saturation * 0.55 + contrast * 0.25,
    softness: 1.18 - saturation * 0.34 + (1 - contrast) * 0.20
  };
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { h: 0, s: 0, l: lightness * 100 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function analyzeCoverImage(image, fallback = fallbackCoverAnalysis()) {
  const fallbackPalette = fallback.palette || fallback;
  const canvas = document.createElement("canvas");
  const size = 64;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const buckets = new Map();
  let brightnessSum = 0;
  let saturationSum = 0;
  let varianceSum = 0;
  let sampleCount = 0;

  for (let index = 0; index < data.length; index += 16) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.32) continue;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const hsl = rgbToHsl(r, g, b);
    const brightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const saturation = hsl.s / 100;
    const weight = 0.34 + saturation * 0.74 + Math.abs(brightness - 0.5) * 0.18;
    const hueBucket = Math.round(hsl.h / 18) * 18;
    const lightBucket = Math.round(hsl.l / 18) * 18;
    const key = `${hueBucket}:${lightBucket}`;
    const current = buckets.get(key) || { h: 0, s: 0, l: 0, weight: 0 };
    current.h += hsl.h * weight;
    current.s += hsl.s * weight;
    current.l += hsl.l * weight;
    current.weight += weight;
    buckets.set(key, current);
    brightnessSum += brightness;
    saturationSum += saturation;
    sampleCount += 1;
  }

  const brightness = sampleCount ? brightnessSum / sampleCount : 0.48;
  const saturation = sampleCount ? saturationSum / sampleCount : 0.62;
  let varianceCount = 0;
  for (let index = 0; index < data.length; index += 16) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.32) continue;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const value = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    varianceSum += Math.abs(value - brightness);
    varianceCount += 1;
  }
  const contrast = Math.min(1, varianceSum / Math.max(1, varianceCount) * 1.75);
  const palette = [...buckets.values()]
    .filter((bucket) => bucket.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map((bucket) => ({
      h: bucket.h / bucket.weight,
      s: Math.min(92, Math.max(28, bucket.s / bucket.weight)),
      l: Math.min(82, Math.max(30, bucket.l / bucket.weight))
    }));

  const safePalette = palette.length ? palette : fallbackPalette;
  return {
    ...fallback,
    palette: safePalette,
    brightness,
    saturation,
    contrast,
    density: 0.86 + (1 - brightness) * 0.34 + contrast * 0.22,
    glow: 0.72 + brightness * 0.46 + saturation * 0.34,
    spread: 0.82 + brightness * 0.32 - contrast * 0.12,
    intensity: 0.72 + saturation * 0.55 + contrast * 0.25,
    softness: 1.18 - saturation * 0.34 + (1 - contrast) * 0.20
  };
}

function lerpHue(from, to, amount) {
  if (!Number.isFinite(from)) return to;
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return (from + delta * amount + 360) % 360;
}

function retintParticles(visualizer, style, amount = 0.5) {
  const palette = style?.palette?.length ? style.palette : coverPalette(app.state?.current);
  const brightness = Number.isFinite(style?.brightness) ? style.brightness : 0.5;
  visualizer.palette = palette;
  for (let index = 0; index < visualizer.particles.length; index += 1) {
    const particle = visualizer.particles[index];
    const tone = palette[index % palette.length] || { h: 205, s: 70, l: 62 };
    particle.hue = lerpHue(particle.hue, tone.h, amount);
    particle.saturation = clampNumber(
      (particle.saturation || tone.s) + (tone.s - (particle.saturation || tone.s)) * amount,
      24,
      96,
      tone.s
    );
    particle.lightness = clampNumber(
      (particle.lightness || tone.l) + (tone.l + brightness * 12 - (particle.lightness || tone.l)) * amount,
      26,
      88,
      tone.l
    );
  }
}

function updateAlbumCover(track) {
  const visualizer = getParticleCover();
  const cover = qs("#coverArt");
  const orb = qs("#albumOrb");
  const image = qs("#albumCover");
  const url = albumCoverUrl(track);
  const fallbackStyle = fallbackCoverAnalysis(track);
  const changedTrack = visualizer.trackKey !== trackKey(track);
  const sameCover = visualizer.coverUrl === url;
  const transitionStyle = sameCover && visualizer.coverStyle ? visualizer.coverStyle : fallbackStyle;

  visualizer.bpm = Number(track?.bpm || 96);
  if (!visualizer.coverStyle || !sameCover) {
    visualizer.coverStyle = fallbackStyle;
    visualizer.palette = fallbackStyle.palette;
  }
  if (changedTrack) {
    retintParticles(visualizer, transitionStyle, 0.58);
    visualizer.transitionBoost = 0.42;
    visualizer.scatter = Math.max(visualizer.scatter, 0.52);
    scatterParticles(visualizer, 2.8);
    visualizer.trackKey = trackKey(track);
  }
  if (sameCover) return;
  visualizer.coverUrl = url;

  if (!url) {
    image.removeAttribute("src");
    image.classList.remove("is-loaded");
    orb.classList.add("is-empty");
    visualizer.image = null;
    visualizer.coverStyle = fallbackCoverAnalysis(track);
    visualizer.palette = visualizer.coverStyle.palette;
    visualizer.targetKey = "";
    visualizer.needsClear = true;
    cover.style.setProperty("--album-bg-opacity", "0");
    cover.style.removeProperty("--album-bg");
    cover.style.setProperty("--album-opacity", "0.34");
    return;
  }

  const token = (visualizer.imageVersion || 0) + 1;
  visualizer.imageVersion = token;
  image.classList.remove("is-loaded");
  image.onload = () => {
    if (visualizer.imageVersion !== token) return;
    visualizer.image = image;
    try {
      visualizer.coverStyle = analyzeCoverImage(image, fallbackStyle);
      visualizer.palette = visualizer.coverStyle.palette;
    } catch {
      visualizer.coverStyle = fallbackStyle;
      visualizer.palette = fallbackStyle.palette;
    }
    visualizer.styleVersion = (visualizer.styleVersion || 0) + 1;
    visualizer.needsClear = true;
    visualizer.transitionBoost = Math.max(visualizer.transitionBoost, 0.64 + visualizer.coverStyle.intensity * 0.22);
    visualizer.scatter = Math.max(visualizer.scatter, 0.38 + visualizer.coverStyle.spread * 0.18);
    buildAlbumParticles(visualizer, true);
    image.classList.add("is-loaded");
    orb.classList.remove("is-empty");
    orb.classList.add("is-active");
    cover.style.setProperty("--album-opacity", "1");
    cover.style.setProperty("--album-bg-opacity", "0.28");
    window.setTimeout(() => orb.classList.remove("is-active"), 680);
  };
  image.onerror = () => {
    if (visualizer.imageVersion !== token) return;
    visualizer.image = null;
    visualizer.coverStyle = fallbackStyle;
    visualizer.palette = fallbackStyle.palette;
    image.classList.remove("is-loaded");
    orb.classList.add("is-empty");
  };
  image.crossOrigin = "anonymous";
  image.referrerPolicy = "no-referrer";
  image.src = url;
  cover.style.setProperty("--album-bg", cssImageUrl(url));
}

function getParticleCover() {
  if (app.particleCover) return app.particleCover;

  const canvas = qs("#visualizer");
  const cover = qs("#coverArt");
  const visualizer = {
    canvas,
    ctx: canvas.getContext("2d"),
    particles: [],
    image: null,
    mouse: { x: 0, y: 0, active: false },
    coverUrl: "",
    imageVersion: 0,
    trackKey: "",
    bpm: 96,
    coverStyle: fallbackCoverAnalysis(app.state?.current),
    palette: fallbackCoverAnalysis(app.state?.current).palette,
    scatter: 0,
    transitionBoost: 0,
    styleVersion: 0,
    targetKey: "",
    needsClear: true,
    frameSkip: 0,
    lastTime: performance.now()
  };

  const pointer = (event) => {
    if (event.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    visualizer.mouse.x = event.clientX - rect.left;
    visualizer.mouse.y = event.clientY - rect.top;
    visualizer.mouse.active = true;
  };

  canvas.addEventListener("pointermove", pointer, { passive: true });
  canvas.addEventListener("pointerenter", pointer, { passive: true });
  canvas.addEventListener("pointerleave", () => {
    visualizer.mouse.active = false;
  }, { passive: true });
  canvas.addEventListener("pointerdown", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (event.pointerType !== "touch") {
      pointer(event);
    }
    burstParticles(visualizer, x, y, event.pointerType === "touch" ? 4 : 7);
  }, { passive: true });
  cover.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    burstParticles(visualizer, event.clientX - rect.left, event.clientY - rect.top, 8);
  });

  app.particleCover = visualizer;
  seedParticles(visualizer);
  return visualizer;
}

function visualizerQuality() {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  const narrowScreen = Math.min(window.innerWidth || 1024, window.innerHeight || 768) < 720;
  const lowMemory = Number(navigator.deviceMemory || 8) <= 4;
  const lowCores = Number(navigator.hardwareConcurrency || 8) <= 4;
  if (reducedMotion) return 0.38;
  if ((coarsePointer && narrowScreen) || lowMemory || lowCores) return 0.38;
  if (coarsePointer || narrowScreen) return 0.48;
  return 1;
}

function ensureParticleCanvas(visualizer) {
  const { canvas, ctx } = visualizer;
  const rect = canvas.getBoundingClientRect();
  const quality = visualizerQuality();
  const dpr = Math.min(window.devicePixelRatio || 1, quality < 0.5 ? 0.95 : quality < 0.7 ? 1.05 : 1.65);
  const width = Math.max(320, rect.width || canvas.width);
  const height = Math.max(320, rect.height || canvas.height);
  const targetWidth = Math.floor(width * dpr);
  const targetHeight = Math.floor(height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    visualizer.targetKey = "";
    visualizer.needsClear = true;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function seedParticles(visualizer) {
  if (visualizer.image?.complete && visualizer.image.naturalWidth) {
    buildAlbumParticles(visualizer);
    return;
  }
  const { width, height } = ensureParticleCanvas(visualizer);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const quality = visualizerQuality();
  const count = Math.floor(Math.max(
    quality < 0.5 ? 70 : 120,
    Math.min(520 * quality, Math.floor((width * height) / (quality < 0.5 ? 7600 : quality < 0.7 ? 5200 : 1800)))
  ));
  while (visualizer.particles.length < count) {
    const angle = Math.random() * Math.PI * 2;
    const orbit = Math.min(width, height) * (0.18 + Math.random() * 0.52);
    const tone = visualizer.palette[Math.floor(Math.random() * visualizer.palette.length)] || { h: 205, s: 72, l: 62 };
    visualizer.particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.sin(angle) * 0.4,
      vy: -Math.cos(angle) * 0.4,
      orbit,
      size: 0.9 + Math.random() * 2.4,
      hue: tone.h + (Math.random() - 0.5) * 16,
      saturation: Math.min(86, Math.max(46, tone.s)),
      lightness: Math.min(76, Math.max(48, tone.l + 8)),
      phase: Math.random() * Math.PI * 2,
      kind: "aura"
    });
  }
  visualizer.particles.length = count;
}

function buildAlbumParticles(visualizer, force = false) {
  const image = visualizer.image;
  if (!image?.complete || !image.naturalWidth) return;
  const { width, height } = ensureParticleCanvas(visualizer);
  const style = visualizer.coverStyle || fallbackCoverAnalysis();
  const quality = visualizerQuality();
  const density = clampNumber(style.density, 0.66, 1.56, 1);
  const spread = clampNumber(style.spread, 0.72, 1.26, 1);
  const intensity = clampNumber(style.intensity, 0.62, 1.62, 1);
  const coverSize = Math.min(width, height) * (0.54 + spread * 0.065);
  const centerX = width * 0.5;
  const centerY = height * 0.51;
  const maxColumns = quality < 0.5 ? 54 : quality < 0.7 ? 72 : 140;
  const maxRows = quality < 0.5 ? 38 : quality < 0.7 ? 52 : 96;
  const baseStep = quality < 0.5 ? 24 : quality < 0.7 ? 20.5 : 13.4;
  const columns = Math.max(quality < 0.5 ? 34 : 46, Math.min(maxColumns, Math.floor(width / (baseStep / density))));
  const rows = Math.max(quality < 0.5 ? 24 : 32, Math.min(maxRows, Math.floor(height / (baseStep / density))));
  const stepX = width / Math.max(1, columns - 1);
  const stepY = height / Math.max(1, rows - 1);
  const previousKey = `${Math.round(width)}:${Math.round(height)}:${columns}:${rows}:${visualizer.styleVersion || 0}:${visualizer.coverUrl}`;
  if (!force && visualizer.targetKey === previousKey && visualizer.particles.length) return;

  const imageRatio = image.naturalWidth / image.naturalHeight;
  const panelRatio = width / height;
  let sx0 = 0;
  let sy0 = 0;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;
  if (imageRatio > panelRatio) {
    sourceWidth = image.naturalHeight * panelRatio;
    sx0 = (image.naturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = image.naturalWidth / panelRatio;
    sy0 = (image.naturalHeight - sourceHeight) / 2;
  }
  const sampleW = sourceWidth / columns;
  const sampleH = sourceHeight / rows;
  let sampleData = null;
  try {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = columns;
    sampleCanvas.height = rows;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    sampleCtx.drawImage(image, sx0, sy0, sourceWidth, sourceHeight, 0, 0, columns, rows);
    sampleData = sampleCtx.getImageData(0, 0, columns, rows).data;
  } catch {
    sampleData = null;
  }
  visualizer.targetKey = previousKey;
  const oldParticles = visualizer.particles;
  const particles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const u = columns === 1 ? 0.5 : col / (columns - 1);
      const v = rows === 1 ? 0.5 : row / (rows - 1);
      const index = particles.length;
      const old = oldParticles[index] || oldParticles[index % Math.max(1, oldParticles.length)];
      const txBase = u * width;
      const tyBase = v * height;
      const coverDistance = Math.hypot((txBase - centerX) / (coverSize * 0.56), (tyBase - centerY) / (coverSize * 0.56));
      const edgeGlow = Math.max(0, 1 - Math.abs(coverDistance - 1.02) * (1.35 + style.contrast * 0.42));
      const focus = 0.42 + edgeGlow * (0.55 + intensity * 0.22) + Math.max(0, 1 - coverDistance) * (0.08 + style.brightness * 0.08);
      const jitterScale = 0.16 + edgeGlow * (0.20 + spread * 0.18) + style.brightness * 0.05;
      const tx = txBase + (Math.random() - 0.5) * stepX * jitterScale;
      const ty = tyBase + (Math.random() - 0.5) * stepY * jitterScale;
      const angle = Math.random() * Math.PI * 2;
      const pixelIndex = (row * columns + col) * 4;
      const pixelAlpha = sampleData ? sampleData[pixelIndex + 3] / 255 : 0;
      const pixelTone = sampleData && pixelAlpha > 0.14
        ? rgbToHsl(sampleData[pixelIndex], sampleData[pixelIndex + 1], sampleData[pixelIndex + 2])
        : null;
      const paletteTone = visualizer.palette[(row + col) % visualizer.palette.length] || { h: old?.hue ?? 205, s: 72, l: 62 };
      const tone = pixelTone || paletteTone;
      const localBrightness = pixelTone ? tone.l / 100 : style.brightness;
      const localSaturation = pixelTone ? tone.s / 100 : style.saturation;
      const localLift = edgeGlow * (4 + intensity * 3) + style.brightness * 8;
      particles.push({
        x: old?.x ?? centerX + Math.cos(angle) * coverSize * (0.35 + Math.random() * 0.34),
        y: old?.y ?? centerY + Math.sin(angle) * coverSize * (0.35 + Math.random() * 0.34),
        vx: old?.vx ?? Math.cos(angle) * 0.8,
        vy: old?.vy ?? Math.sin(angle) * 0.8,
        tx,
        ty,
        sx: Math.min(image.naturalWidth - sampleW, sx0 + u * Math.max(0, sourceWidth - sampleW)),
        sy: Math.min(image.naturalHeight - sampleH, sy0 + v * Math.max(0, sourceHeight - sampleH)),
        sampleW,
        sampleH,
        focus: Math.min(1.34, focus * (0.92 + localSaturation * 0.16 + Math.abs(localBrightness - style.brightness) * 0.14)),
        size: Math.max(0.52, Math.min(stepX, stepY) * (0.085 + edgeGlow * (0.040 + intensity * 0.018)) * (0.76 + localSaturation * 0.18 + Math.random() * 0.50)),
        hue: tone.h + (Math.random() - 0.5) * 12,
        saturation: Math.min(96, Math.max(24, tone.s * (0.70 + style.saturation * 0.62))),
        lightness: Math.min(86, Math.max(28, tone.l + localLift + (1 - localBrightness) * 3)),
        phase: old?.phase ?? Math.random() * Math.PI * 2,
        kind: "album"
      });
    }
  }
  visualizer.particles = particles;
}

function scatterParticles(visualizer, power = 6) {
  const { width, height } = ensureParticleCanvas(visualizer);
  const cx = width * 0.5;
  const cy = height * 0.5;
  for (const particle of visualizer.particles) {
    const dx = particle.x - cx;
    const dy = particle.y - cy;
    const distance = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.34;
    const force = power * (0.22 + Math.random() * 0.36);
    particle.vx += Math.cos(angle) * force + (dx / distance) * power * 0.10;
    particle.vy += Math.sin(angle) * force + (dy / distance) * power * 0.10;
  }
  visualizer.scatter = Math.max(visualizer.scatter, 0.56);
  visualizer.transitionBoost = Math.max(visualizer.transitionBoost, 0.36);
  visualizer.needsClear = true;
}

function burstParticles(visualizer, x, y, power = 18) {
  for (const particle of visualizer.particles) {
    const dx = particle.x - x;
    const dy = particle.y - y;
    const distance = Math.hypot(dx, dy) || 1;
    const force = Math.max(0, 1 - distance / 260) * power * 0.24;
    particle.vx += (dx / distance) * force;
    particle.vy += (dy / distance) * force;
  }
  visualizer.scatter = Math.max(visualizer.scatter, 0.5);
  visualizer.transitionBoost = Math.max(visualizer.transitionBoost, 0.28);
}

function animateVisualizer() {
  startParticleCover();
}

function animateMockVisualizer() {
  startParticleCover();
}

function drawIdle() {
  startParticleCover();
}

function startParticleCover() {
  const visualizer = getParticleCover();
  if (app.animation) return;
  visualizer.lastTime = performance.now();
  const draw = (now) => {
    drawParticleCover(visualizer, now);
    app.animation = requestAnimationFrame(draw);
  };
  app.animation = requestAnimationFrame(draw);
}

function drawParticleCover(visualizer, now = performance.now()) {
  if (document.hidden) {
    visualizer.lastTime = now;
    return;
  }
  const rect = visualizer.canvas.getBoundingClientRect();
  if (rect.bottom < -80 || rect.top > window.innerHeight + 80) {
    visualizer.lastTime = now;
    return;
  }
  const quality = visualizerQuality();
  visualizer.frameSkip = (visualizer.frameSkip || 0) + 1;
  const mobileLite = quality < 0.5;
  const frameModulo = mobileLite ? 3 : 2;
  if (quality < 0.7 && !visualizer.mouse.active && !visualizer.scatter && !visualizer.transitionBoost && !visualizer.needsClear && visualizer.frameSkip % frameModulo) {
    return;
  }
  seedParticles(visualizer);
  const { canvas, ctx, particles, mouse } = visualizer;
  const { width, height } = ensureParticleCanvas(visualizer);
  const dt = Math.min(1.6, Math.max(0.35, (now - visualizer.lastTime) / 16.67));
  visualizer.lastTime = now;

  const cx = width * 0.5;
  const cy = height * 0.5;
  const style = visualizer.coverStyle || fallbackCoverAnalysis();
  const glowScale = clampNumber(style.glow, 0.55, 1.62, 1);
  const intensity = clampNumber(style.intensity, 0.56, 1.75, 1);
  const spread = clampNumber(style.spread, 0.72, 1.32, 1);
  const softness = clampNumber(style.softness, 0.82, 1.62, 1);
  const baseOrbit = Math.min(width, height) * 0.30;
  const bpm = Math.max(52, Math.min(180, visualizer.bpm || 96));
  const audioTime = app.media?.currentTime || now / 1000;
  const beat = app.playing ? (0.18 + Math.sin(audioTime * (bpm / 60) * Math.PI * 2) * (0.024 + style.brightness * 0.024)) : 0.10;
  visualizer.transitionBoost *= 0.90;
  visualizer.scatter *= 0.965;
  if (visualizer.scatter < 0.015) visualizer.scatter = 0;
  const scatter = visualizer.scatter;
  const pulse = 1 + beat * (0.008 + spread * 0.004) + visualizer.transitionBoost * (0.018 + spread * 0.010);

  if (visualizer.needsClear) {
    ctx.clearRect(0, 0, width, height);
    visualizer.needsClear = false;
  }
  ctx.fillStyle = `rgba(1, 2, 5, ${mouse.active || scatter ? 0.19 + (1 - style.brightness) * 0.06 : 0.23 + (1 - style.brightness) * 0.07})`;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.64);
  const accent = visualizer.palette[0] || { h: 205, s: 70, l: 62 };
  glow.addColorStop(0, `hsla(${accent.h}, ${Math.min(88, accent.s)}%, ${Math.min(84, accent.l + 12)}%, ${(0.020 + beat * 0.010) * glowScale})`);
  glow.addColorStop(0.35, `hsla(${accent.h}, ${Math.min(88, accent.s)}%, ${Math.min(78, accent.l + 6)}%, ${(0.026 + visualizer.transitionBoost * 0.020) * glowScale})`);
  glow.addColorStop(0.78, `hsla(${accent.h + 34}, ${Math.min(82, accent.s)}%, ${Math.min(74, accent.l + 2)}%, ${0.014 * glowScale})`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const particle of particles) {
    const isAlbumParticle = particle.kind === "album" && visualizer.image?.complete;
    if (isAlbumParticle) {
      const drift = (0.58 + spread * 0.42) + scatter * (6 + spread * 6) + beat * (0.7 + spread * 0.8);
      const targetX = cx + (particle.tx - cx) * pulse + Math.sin(now / 1800 + particle.phase) * drift;
      const targetY = cy + (particle.ty - cy) * pulse + Math.cos(now / 2100 + particle.phase) * drift;
      const pull = Math.max(0.014, (0.026 + style.contrast * 0.014) * (1 - scatter * 0.24));
      particle.vx += (targetX - particle.x) * pull * dt;
      particle.vy += (targetY - particle.y) * pull * dt;

      const orbitDx = particle.x - cx;
      const orbitDy = particle.y - cy;
      const orbitDistance = Math.hypot(orbitDx, orbitDy) || 1;
      const tangent = (0.00035 + beat * 0.0007 + scatter * (0.0012 + spread * 0.0009)) * dt;
      particle.vx += (-orbitDy / orbitDistance) * tangent;
      particle.vy += (orbitDx / orbitDistance) * tangent;
    } else {
      const dx = particle.x - cx;
      const dy = particle.y - cy;
      const distance = Math.hypot(dx, dy) || 1;
      const targetOrbit = (baseOrbit + particle.orbit * 0.35) * pulse;
      const radial = (targetOrbit - distance) * 0.0024;
      const tangent = 0.003 + beat * 0.0012;
      particle.vx += (dx / distance) * radial * dt + (-dy / distance) * tangent * dt;
      particle.vy += (dy / distance) * radial * dt + (dx / distance) * tangent * dt;
    }

    if (mouse.active) {
      const mdx = particle.x - mouse.x;
      const mdy = particle.y - mouse.y;
      const md = Math.hypot(mdx, mdy) || 1;
      if (md < 180) {
        const force = (1 - md / 180) * (isAlbumParticle ? 0.85 : 0.58);
        particle.vx += (mdx / md) * force * dt;
        particle.vy += (mdy / md) * force * dt;
      } else if (md < 330) {
        const force = (1 - (md - 180) / 150) * 0.08;
        particle.vx -= (mdx / md) * force * dt;
        particle.vy -= (mdy / md) * force * dt;
      }
    }

    particle.vx *= isAlbumParticle ? 0.88 : 0.94;
    particle.vy *= isAlbumParticle ? 0.88 : 0.94;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;

    if (particle.x < -120 || particle.x > width + 120 || particle.y < -120 || particle.y > height + 120) {
      const angle = Math.random() * Math.PI * 2;
      const fallbackOrbit = baseOrbit * (0.88 + Math.random() * 0.28);
      particle.x = isAlbumParticle ? Math.random() * width : cx + Math.cos(angle) * fallbackOrbit;
      particle.y = isAlbumParticle ? Math.random() * height : cy + Math.sin(angle) * fallbackOrbit;
      particle.vx *= 0.2;
      particle.vy *= 0.2;
    }

    const shimmer = 0.56 + Math.sin(now / 2400 + particle.phase) * 0.045 + beat * 0.035;
    const toneHue = Number.isFinite(particle.hue) ? particle.hue : 205;
    const toneSaturation = Math.min(86, Math.max(42, particle.saturation || 68));
    const toneLightness = Math.min(70, Math.max(42, particle.lightness || 58));
    const radius = particle.size * (isAlbumParticle ? 1.05 : 1.35)
      * (0.70 + beat * 0.035 + scatter * 0.10 + visualizer.transitionBoost * 0.035 + (1 - style.brightness) * 0.08);
    const focus = Math.max(0.36, particle.focus || 0.72);
    const coreAlpha = Math.min(isAlbumParticle ? 0.42 : 0.24, ((isAlbumParticle ? 0.058 : 0.034) + shimmer * 0.090) * focus * intensity * (0.82 + glowScale * 0.22));
    const glowRadius = radius * (isAlbumParticle ? 2.8 + softness * 0.72 : 3.6 + softness * 0.82);
    if (!mobileLite) {
      const glow = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
      glow.addColorStop(0, `hsla(${toneHue}, ${toneSaturation}%, ${toneLightness + 8}%, ${coreAlpha * 0.34})`);
      glow.addColorStop(0.52, `hsla(${toneHue}, ${toneSaturation}%, ${toneLightness}%, ${coreAlpha * 0.12})`);
      glow.addColorStop(1, `hsla(${toneHue}, ${toneSaturation}%, ${toneLightness}%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = `hsla(${toneHue}, ${toneSaturation}%, ${toneLightness + 10}%, ${mobileLite ? Math.min(coreAlpha * 1.65, 0.34) : coreAlpha})`;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, mobileLite ? Math.max(0.95, radius * 1.2) : radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (!mobileLite) {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `rgba(170, 225, 238, ${0.030 + beat * 0.020})`;
    ctx.lineWidth = 0.8;
    for (let ring = 0; ring < 3; ring += 1) {
      const radius = (baseOrbit * (0.72 + ring * 0.16)) * pulse + Math.sin(now / 850 + ring) * 8;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * 1.04, radius * 0.84, Math.sin(now / 2600) * 0.18, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

async function sendChat(event) {
  event.preventDefault();
  const input = qs("#chatInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message })
    });
    render(result.payload);
    applyCommandPlayback(result);
    speak(result.say);
  } catch {
    toast("发送失败");
  }
}

function applyCommandPlayback(result) {
  const action = result.command?.action;
  if (action === "stop") {
    app.playing = false;
    setIcon("play");
    stopNodes();
    return;
  }

  const shouldAutoplay = ["search_play", "next", "dislike"].includes(action);
  if (shouldAutoplay) {
    app.playing = true;
    setIcon("pause");
    startTrack(result.payload.current);
  }
}

function isNoPlayableError(error) {
  return error?.payload?.code === "NETEASE_NO_PLAYABLE_URL"
    || /拿不到|可播放链接|版权|会员|限制/.test(error?.message || "");
}

function playbackToast(result, fallbackTitle) {
  const title = result?.track?.title || fallbackTitle || "这首歌";
  if (result?.skipped) return `已跳过 ${result.skipped} 首暂时不可播歌曲，正在播放《${title}》`;
  return `正在播放《${title}》`;
}

async function playFallbackNext({ announce = false, autoplay = app.playing } = {}) {
  const payload = await api("/api/next");
  render(payload);
  if (autoplay) {
    app.playing = true;
    setIcon("pause");
    startTrack(payload.current);
  }
  if (announce) speak(`下一首，《${payload.current.title}》。`);
  return { payload, track: payload.current };
}

async function playNeteaseTrack(track, { announce = false } = {}) {
  const endpoint = app.playlistMode === "account" ? "/api/netease/account/play" : "/api/netease/play";
  const result = await api(endpoint, {
    method: "POST",
    body: JSON.stringify({ song: track })
  });
  render(result.payload);
  app.playing = true;
  setIcon("pause");
  startTrack(result.payload.current);
  if (announce) speak(`现在播放《${result.payload.current.title}》。`);
  return result;
}

async function playPlaylistIndex(index, { announce = false, direction = 1 } = {}) {
  const requestedIndex = Number(index);
  if (app.playlistMode === "account" && requestedIndex >= app.playlist.length && app.accountSongsHasMore) {
    const currentTrack = app.playlist[app.currentIndex] || app.state?.current;
    await loadMoreAccountSongs({ silent: true });
    app.playlist = app.accountSongs.slice();
    const currentIndex = findPlaylistIndex(currentTrack, app.playlist);
    app.currentIndex = currentIndex >= 0 ? currentIndex : Math.min(app.currentIndex, app.playlist.length - 1);
  }
  if (!app.playlist.length) return false;
  const length = app.playlist.length;
  const startIndex = requestedIndex;
  let skipped = 0;
  let lastError = null;

  for (let attempt = 0; attempt < length; attempt += 1) {
    app.currentIndex = ((startIndex + attempt * direction) % length + length) % length;
    const track = app.playlist[app.currentIndex];
    if (!track) continue;
    try {
      let result;
      if (track.id && (app.playlistMode === "queue" || app.playlistMode === "catalog" || isKnownCatalogTrack(track))) {
        result = await playTrack(track.id, { announce, preservePlaylist: true });
      } else {
        result = await playNeteaseTrack(track, { announce });
      }
      return { ...(result || {}), skipped };
    } catch (error) {
      if (!isNoPlayableError(error)) throw error;
      skipped += 1;
      lastError = error;
    }
  }

  throw lastError || new Error("这一组歌暂时都拿不到播放链接");
}

async function handleTrackEnded() {
  try {
    app.playing = true;
    setIcon("pause");
    if (await playPlaylistIndex(app.currentIndex + 1, { announce: false })) return;
    await playFallbackNext({ announce: false, autoplay: true });
  } catch (error) {
    toast(error.message || "下一首暂时播放不了");
  }
}

async function nextTrack() {
  try {
    app.playing = true;
    setIcon("pause");
    const result = await playPlaylistIndex(app.currentIndex + 1);
    if (result) {
      if (result.skipped) toast(playbackToast(result));
      return;
    }
    await playFallbackNext({ autoplay: true });
  } catch (error) {
    toast(error.message || "下一首暂时播放不了");
  }
}

async function previousTrack() {
  if (!app.playlist.length) {
    toast("还没有可返回的上一首");
    return;
  }
  try {
    app.playing = true;
    setIcon("pause");
    const result = await playPlaylistIndex(app.currentIndex - 1, { direction: -1 });
    if (result?.skipped) toast(playbackToast(result));
  } catch (error) {
    toast(error.message || "上一首暂时播放不了");
  }
}

async function playTrack(trackId, { announce = false, preservePlaylist = false } = {}) {
  const body = { trackId };
  if (preservePlaylist && app.playlistMode === "queue") body.playlist = playlistIds();
  const payload = await api("/api/play", {
    method: "POST",
    body: JSON.stringify(body)
  });
  render(payload);
  app.playing = true;
  setIcon("pause");
  startTrack(payload.current);
  if (announce) speak(`现在播放《${payload.current.title}》。`);
  return { payload, track: payload.current };
}

async function feedback(signal) {
  const payload = await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ signal, trackId: app.state?.current?.id })
  });
  render(payload);
  toast(signal === "like" ? "已加入偏好" : "已降低权重");
}

async function generatePlan() {
  const result = await api("/api/recommendations?limit=8");
  render(result.payload);
  toast("已换一组歌单外推荐");
}

async function playRecommendation(index) {
  const track = app.recommendations[Number(index)];
  if (!track) return;
  setPlaylist(app.recommendations, track, "recommendations");
  try {
    const result = await playPlaylistIndex(Number(index));
    toast(playbackToast(result, track.title));
  } catch (error) {
    toast(error.message || "这首推荐暂时拿不到播放链接");
  }
}

async function searchNetease(event) {
  event.preventDefault();
  const input = qs("#neteaseSearchInput");
  const keyword = input.value.trim();
  if (!keyword) return;

  const list = qs("#neteaseResults");
  list.innerHTML = `<div class="empty-state">正在搜索网易云音乐...</div>`;
  try {
    const result = await api(`/api/netease/search?q=${encodeURIComponent(keyword)}&limit=12`);
    app.neteaseResults = result.songs || [];
    qs("#neteaseMode").textContent = result.mode || "public";
    renderNeteaseResults(app.neteaseResults);
  } catch {
    list.innerHTML = `<div class="empty-state">网易云搜索暂时失败，可以稍后再试。</div>`;
  }
}

async function importNetease(index) {
  const song = app.neteaseResults[Number(index)];
  if (!song) return;
  try {
    const result = await api("/api/netease/import", {
      method: "POST",
      body: JSON.stringify({ song })
    });
    render(result.payload);
    toast(`已导入《${result.track.title}》`);
  } catch {
    toast("导入失败");
  }
}

async function playNeteaseResult(index) {
  const song = app.neteaseResults[Number(index)];
  if (!song) return;
  setPlaylist(app.neteaseResults, song, "search");
  try {
    const result = await playPlaylistIndex(Number(index));
    toast(playbackToast(result, song.title));
  } catch (error) {
    toast(error.message || "这首歌暂时拿不到可播放链接");
  }
}

async function refreshNeteaseAccount() {
  try {
    const status = await api("/api/netease/account/status");
    app.neteaseUserId = status.loggedIn ? String(status.profile?.userId || "") : "";
    renderNeteaseAccount({ loggedIn: status.loggedIn, profile: status.profile });
    qs("#neteaseMode").textContent = status.mode || "public";
    if (status.loggedIn) loadAccountPlaylists();
    if (!status.apiAvailable) toast(status.message || "请先启动 NeteaseCloudMusicApi");
    return status;
  } catch {
    toast("无法连接 NeteaseCloudMusicApi");
    return null;
  }
}

async function startNeteaseQrLogin() {
  clearInterval(app.qrTimer);
  const box = qs("#neteaseQrBox");
  box.innerHTML = `<div class="empty-state compact">正在生成二维码...</div>`;
  try {
    const qr = await api("/api/netease/account/qr", { method: "POST", body: "{}" });
    app.qrKey = qr.key;
    box.innerHTML = `
      <img class="qr-img" src="${qr.qrimg}" alt="网易云登录二维码">
      <span>用网易云音乐 App 扫码确认登录</span>
    `;
    app.qrTimer = setInterval(checkNeteaseQrLogin, 1800);
  } catch {
    box.innerHTML = `<div class="empty-state compact">二维码生成失败。请确认 NeteaseCloudMusicApi 已启动。</div>`;
  }
}

async function checkNeteaseQrLogin() {
  if (!app.qrKey) return;
  try {
    const result = await api(`/api/netease/account/qr/check?key=${encodeURIComponent(app.qrKey)}`);
    if (result.loggedIn) {
      clearInterval(app.qrTimer);
      app.qrTimer = null;
      app.neteaseUserId = String(result.profile?.userId || "");
      qs("#neteaseQrBox").innerHTML = `<div class="empty-state compact">登录成功，可以读取你的歌单了。</div>`;
      await loadAccountPlaylists({ force: true });
      await loadNow();
    }
  } catch {
    clearInterval(app.qrTimer);
    app.qrTimer = null;
  }
}

async function logoutNetease() {
  await api("/api/netease/account/logout", { method: "POST", body: "{}" });
  clearInterval(app.qrTimer);
  app.qrTimer = null;
  app.qrKey = "";
  app.neteaseUserId = "";
  app.accountPlaylistId = "";
  app.accountSongsHasMore = false;
  app.accountSongsLoading = false;
  app.accountSongsSyncing = false;
  app.accountSongsNextOffset = 0;
  removeLocalCache(lastPlaylistCacheKey());
  renderNeteaseAccount(null);
  renderPlaylists([]);
  renderAccountSongs([]);
  toast("已断开网易云账号");
}

function hydratePlaylistSongsFromCache(playlistId) {
  const cached = readPlaylistSongsCache(playlistId);
  if (!cached) return false;
  app.accountPlaylistId = String(playlistId);
  app.accountSongs = cached.songs;
  app.accountSongsHasMore = Boolean(cached.hasMore);
  app.accountSongsNextOffset = cached.nextOffset || cached.songs.length;
  app.accountSongsLoading = false;
  app.accountSongsSyncing = false;
  renderPlaylists(app.accountPlaylists);
  renderAccountSongs(app.accountSongs);
  return true;
}

async function loadPlaylistSongPage(playlistId, { offset = 0, silent = false } = {}) {
  if (!playlistId || app.accountSongsLoading) return null;
  const selectedId = String(playlistId);
  if (!silent) app.accountSongsLoading = true;
  else app.accountSongsSyncing = true;
  renderAccountSongs(app.accountSongs);

  try {
    const result = await api(`/api/netease/account/playlist?id=${encodeURIComponent(selectedId)}&limit=${app.accountPageSize}&offset=${offset}`);
    if (String(app.accountPlaylistId) !== selectedId) return null;
    const incoming = result.songs || [];
    app.accountSongs = mergeSongPage(app.accountSongs, incoming, offset);
    app.accountSongsNextOffset = Number(result.nextOffset || offset + incoming.length || app.accountSongs.length);
    app.accountSongsHasMore = Boolean(result.hasMore) && incoming.length > 0;
    savePlaylistSongsCache(selectedId);
    renderAccountSongs(app.accountSongs);
    return result;
  } catch (error) {
    if (!app.accountSongs.length) {
      qs("#accountSongs").innerHTML = `<div class="empty-state compact">歌单读取失败，稍后再试。</div>`;
    } else if (!silent) {
      toast(error.message || "继续载入失败");
    }
    return null;
  } finally {
    if (String(app.accountPlaylistId) === selectedId) {
      if (!silent) app.accountSongsLoading = false;
      else app.accountSongsSyncing = false;
      renderAccountSongs(app.accountSongs);
    }
  }
}

async function syncPlaylistSongs(playlistId) {
  const cached = readPlaylistSongsCache(playlistId);
  if (cached && Date.now() - Number(cached.cachedAt || 0) < ACCOUNT_SYNC_INTERVAL) return cached;
  return loadPlaylistSongPage(playlistId, { offset: 0, silent: true });
}

async function loadMoreAccountSongs({ silent = false } = {}) {
  if (!app.accountPlaylistId || app.accountSongsLoading || !app.accountSongsHasMore) return null;
  const offset = app.accountSongsNextOffset || app.accountSongs.length;
  return loadPlaylistSongPage(app.accountPlaylistId, { offset, silent });
}

function maybeLoadMoreAccountSongs() {
  if (!app.accountPlaylistId || !app.accountSongsHasMore || app.accountSongsLoading) return;
  const list = qs("#accountSongs");
  if (!list) return;
  const rect = list.getBoundingClientRect();
  if (rect.bottom < window.innerHeight + 700) loadMoreAccountSongs({ silent: true });
}

async function loadAccountPlaylists({ force = false } = {}) {
  const cached = readLocalCache(playlistListCacheKey());
  if (cached?.playlists?.length) renderPlaylists(cached.playlists);
  const lastPlaylist = readLocalCache(lastPlaylistCacheKey());
  if (lastPlaylist?.playlistId && !app.accountPlaylistId) {
    const restored = hydratePlaylistSongsFromCache(lastPlaylist.playlistId);
    if (restored) syncPlaylistSongs(lastPlaylist.playlistId);
  }
  if (!force && cached && Date.now() - Number(cached.cachedAt || 0) < ACCOUNT_SYNC_INTERVAL) return cached;

  const playlistList = qs("#accountPlaylists");
  if (!cached?.playlists?.length) playlistList.innerHTML = `<div class="empty-state compact">正在读取你的歌单...</div>`;
  try {
    const result = await api("/api/netease/account/playlists");
    const playlists = result.playlists || [];
    writeLocalCache(playlistListCacheKey(), cachePayload({ playlists }));
    if (!cached?.playlists || !similarJson(playlists, app.accountPlaylists)) renderPlaylists(playlists);
    return result;
  } catch {
    if (!cached?.playlists?.length) playlistList.innerHTML = `<div class="empty-state compact">读取失败。请先扫码登录网易云账号。</div>`;
    return null;
  }

  const list = qs("#accountPlaylists");
  list.innerHTML = `<div class="empty-state compact">正在读取你的歌单...</div>`;
  try {
    const result = await api("/api/netease/account/playlists");
    renderPlaylists(result.playlists || []);
  } catch {
    list.innerHTML = `<div class="empty-state compact">读取失败。请先扫码登录网易云账号。</div>`;
  }
}

async function loadPlaylistSongs(playlistId) {
  app.accountPlaylistId = String(playlistId || "");
  app.accountSongs = [];
  app.accountSongsHasMore = false;
  app.accountSongsLoading = false;
  app.accountSongsSyncing = false;
  app.accountSongsNextOffset = 0;
  writeLocalCache(lastPlaylistCacheKey(), cachePayload({ playlistId: app.accountPlaylistId }));
  renderPlaylists(app.accountPlaylists);

  const restored = hydratePlaylistSongsFromCache(app.accountPlaylistId);
  if (restored) {
    syncPlaylistSongs(app.accountPlaylistId);
    return;
  }

  app.accountSongsHasMore = true;
  app.accountSongsLoading = true;
  renderAccountSongs([]);
  app.accountSongsLoading = false;
  await loadPlaylistSongPage(app.accountPlaylistId, { offset: 0 });
  return;

  const list = qs("#accountSongs");
  list.innerHTML = `<div class="empty-state compact">正在读取歌单歌曲...</div>`;
  try {
    const result = await api(`/api/netease/account/playlist?id=${encodeURIComponent(playlistId)}&limit=${app.accountPageSize}&offset=0`);
    renderAccountSongs(result.songs || []);
    if ((result.songs || []).length >= 200) toast("已先载入前 200 首，播放时会自动跳过不可播歌曲");
  } catch {
    list.innerHTML = `<div class="empty-state compact">歌单读取失败。</div>`;
  }
}

async function playAccountSong(index) {
  const song = app.accountSongs[Number(index)];
  if (!song) return;
  setPlaylist(app.accountSongs, song, "account");
  try {
    const result = await playPlaylistIndex(Number(index));
    toast(playbackToast(result, song.title));
  } catch (error) {
    toast(error.message || "这首歌暂时拿不到可播放链接，可能受版权限制。");
  }
}

async function addManualSong(event) {
  event.preventDefault();
  const title = qs("#manualTitle").value.trim();
  const artist = qs("#manualArtist").value.trim();
  if (!title || !artist) return;

  try {
    const form = new FormData(qs("#manualSongForm"));
    const result = await apiForm("/api/catalog/upload", form);
    qs("#manualSongForm").reset();
    render(result.payload);
    toast(`已加入《${result.track.title}》`);
  } catch {
    toast("添加失败");
  }
}

function collectProfile() {
  return {
    name: qs("#profileName").value.trim() || "你",
    city: qs("#profileCity").value.trim() || "本地",
    preferredTags: selectedTags("#preferredTags", "is-selected"),
    blockedTags: selectedTags("#blockedTags", "is-blocked"),
    voiceEnabled: qs("#voiceEnabled").checked,
    voiceMode: qs("#voiceMode").value,
    neuralVoice: qs("#neuralVoiceSelect").value,
    voiceName: qs("#voiceSelect").value,
    voiceRate: Number(qs("#voiceRate").value),
    voicePitch: Number(qs("#voicePitch").value),
    crossfade: Number(qs("#crossfade").value),
    routines: {
      morning: qs("#routineMorning").value,
      work: qs("#routineWork").value,
      evening: qs("#routineEvening").value,
      night: qs("#routineNight").value
    }
  };
}

function selectedTags(selector, className) {
  return qsa(`.tag-choice.${className}`, qs(selector)).map((button) => button.dataset.tag);
}

async function saveProfile() {
  const payload = await api("/api/taste", {
    method: "POST",
    body: JSON.stringify(collectProfile())
  });
  render(payload);
  toast("已保存");
}

const viewRoutes = {
  player: "/",
  profile: "/profile",
  library: "/library",
  settings: "/settings"
};

function viewFromPath() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return Object.entries(viewRoutes).find(([, route]) => route === path)?.[0] || "player";
}

function switchView(view, options = {}) {
  const safeView = viewRoutes[view] ? view : "player";
  qsa(".nav-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === safeView));
  qsa(".view").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.view === safeView));
  if (options.push !== false && window.location.pathname !== viewRoutes[safeView]) {
    history.pushState({ view: safeView }, "", viewRoutes[safeView]);
  }
}

function toast(text) {
  let el = qs(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("is-visible");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove("is-visible"), 1800);
}

function bindEvents() {
  qs("#playButton").addEventListener("click", togglePlay);
  qs("#prevButton").addEventListener("click", previousTrack);
  qs("#nextButton").addEventListener("click", nextTrack);
  qs("#shuffleButton").addEventListener("click", generatePlan);
  qs("#planButton").addEventListener("click", generatePlan);
  qs("#refreshButton").addEventListener("click", loadNow);
  qs("#likeButton").addEventListener("click", () => feedback("like"));
  qs("#dislikeButton").addEventListener("click", () => feedback("dislike"));
  qs("#chatForm").addEventListener("submit", sendChat);
  qs("#saveProfileButton").addEventListener("click", saveProfile);
  qs("#saveSettingsButton").addEventListener("click", saveProfile);
  qs("#neteaseSearchForm").addEventListener("submit", searchNetease);
  qs("#manualSongForm").addEventListener("submit", addManualSong);
  qs("#neteaseStatusButton").addEventListener("click", refreshNeteaseAccount);
  qs("#neteaseQrButton").addEventListener("click", startNeteaseQrLogin);
  qs("#loadPlaylistsButton").addEventListener("click", () => loadAccountPlaylists({ force: true }));
  qs("#neteaseLogoutButton").addEventListener("click", logoutNetease);
  qs("#voiceEnabled").addEventListener("change", () => updateVoiceLabel());
  qs("#voiceMode").addEventListener("change", () => updateVoiceLabel());
  qs("#neuralVoiceSelect").addEventListener("change", () => updateVoiceLabel());
  qs("#voiceSelect").addEventListener("change", () => updateVoiceLabel());

  const progressRange = qs("#progressRange");
  const previewSeek = () => {
    const ratio = Number(progressRange.value) / 1000;
    app.seeking = true;
    updateProgress(ratio * (app.progressDuration || 0));
  };
  const commitSeek = () => {
    const ratio = Number(progressRange.value) / 1000;
    app.seeking = false;
    seekToRatio(ratio);
  };
  progressRange.addEventListener("pointerdown", previewSeek);
  progressRange.addEventListener("input", previewSeek);
  progressRange.addEventListener("change", commitSeek);
  progressRange.addEventListener("pointerup", commitSeek);
  progressRange.addEventListener("pointercancel", () => {
    app.seeking = false;
    updateProgress(app.media?.currentTime || 0);
  });

  qs("#queueList").addEventListener("click", (event) => {
    const item = event.target.closest(".queue-item");
    if (!item) return;
    const queue = app.state?.queue || [];
    const track = queue[Number(item.dataset.trackIndex)] || queue.find((entry) => entry.id === item.dataset.trackId);
    if (!track) return;
    setPlaylist(queue, track, "queue");
    playPlaylistIndex(findPlaylistIndex(track));
  });

  qs("#planList").addEventListener("click", (event) => {
    const item = event.target.closest("[data-play-recommendation]");
    if (item) playRecommendation(item.dataset.playRecommendation);
  });

  qs("#neteaseResults").addEventListener("click", (event) => {
    const playButton = event.target.closest("[data-play-netease-result]");
    if (playButton) playNeteaseResult(playButton.dataset.playNeteaseResult);
    const button = event.target.closest("[data-import-netease]");
    if (button) importNetease(button.dataset.importNetease);
  });

  qs("#catalogList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-play-track]");
    if (!button) return;
    const catalog = app.state?.catalog || [];
    const track = catalog.find((entry) => entry.id === button.dataset.playTrack);
    if (!track) return;
    setPlaylist(catalog, track, "catalog");
    playPlaylistIndex(findPlaylistIndex(track));
  });

  qs("#accountPlaylists").addEventListener("click", (event) => {
    const item = event.target.closest("[data-playlist-id]");
    if (item) loadPlaylistSongs(item.dataset.playlistId);
  });

  qs("#accountSongs").addEventListener("click", (event) => {
    const loadMoreButton = event.target.closest("[data-load-more-account]");
    if (loadMoreButton) {
      loadMoreAccountSongs();
      return;
    }
    const button = event.target.closest("[data-play-account-song]");
    if (button) playAccountSong(button.dataset.playAccountSong);
  });
  window.addEventListener("scroll", maybeLoadMoreAccountSongs, { passive: true });
  qs("#accountSongs").addEventListener("scroll", maybeLoadMoreAccountSongs, { passive: true });

  qsa(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  window.addEventListener("popstate", () => switchView(viewFromPath(), { push: false }));

  document.addEventListener("click", (event) => {
    const tag = event.target.closest(".tag-choice");
    if (!tag) return;
    const parent = tag.closest(".chip-cloud");
    if (parent?.id === "preferredTags") tag.classList.toggle("is-selected");
    if (parent?.id === "blockedTags") tag.classList.toggle("is-blocked");
  });
}

async function boot() {
  await clearOldCaches().catch(() => {});
  bindEvents();
  switchView(viewFromPath(), { push: false });
  if (window.speechSynthesis) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  await loadTtsVoices();
  refreshIcons();
  renderNeteaseResults([]);
  renderPlaylists([]);
  renderAccountSongs([]);
  await restoreUserSessionSnapshot();
  await loadNow();
  const recommendationResult = await api("/api/recommendations?limit=8").catch(() => null);
  if (recommendationResult?.payload) render(recommendationResult.payload);
  await refreshNeteaseAccount();
  openStream();
  setInterval(drawIdle, 120);
  setInterval(() => {
    if (app.accountPlaylistId) syncPlaylistSongs(app.accountPlaylistId);
  }, ACCOUNT_SYNC_INTERVAL);
}

boot();
