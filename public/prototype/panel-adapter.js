"use strict";

// Maps panel JSON onto the snapshot shapes in demo-data.js.
// Fields the response does not carry stay null or are omitted. Nothing here is guessed.

const CATEGORY_TYPE = {
  game: "Игра",
  media: "Видео",
  series: "Сериал",
  music: "Музыка",
  documents: "Документ",
  software: "Софт",
  installer: "Софт",
};

const TORRENT_STATE = {
  downloading: "down",
  metadata: "down",
  stalled: "down",
  paused: "pause",
  queued: "wait",
  seeding: "seed",
  checking: "check",
  moving: "move",
  error: "error",
  missing: "missing",
};

const COPY_STATE = {
  queued: "queued",
  running: "running",
  paused: "paused",
  completed: "done",
  error: "error",
  cancelled: "cancelled",
};

// Same phrase as CHANNEL_TEXT.agentMissing. A stale heartbeat is the offline signal for the PC job agent.
const PC_AGENT_MISSING = "Агент Windows не заявлен.";

export class PanelError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "PanelError";
    this.code = code;
    this.status = status;
  }
}

export function demoEnabled(search, dev) {
  return dev === true && new URLSearchParams(String(search || "")).get("demo") === "1";
}

export function loadingSnapshot() {
  return {
    hosts: [],
    disks: [],
    files: [],
    torrents: [],
    tasks: [],
    history: [],
    rules: {},
    manifests: {},
    comparisons: [],
    devices: [],
    gamePool: null,
    imageDisk: null,
    loading: true,
    error: null,
    notices: [],
    demo: false,
    automation: false,
    previewFresh: false,
    unavailable: ["history", "disk.kind", "disk.location", "rules", "devices"],
    torrentHosts: [],
    destinations: [],
    copyUnavailable: false,
    demoTransferRate: null,
  };
}

function text(value) {
  return typeof value === "string" && value ? value : null;
}

export function mapDisk(disk) {
  if (!disk || typeof disk.id !== "string" || !disk.id) return null;
  const mounts = Array.isArray(disk.mountPaths) ? disk.mountPaths.filter((item) => text(item)) : [];
  const last = text(disk.lastMountPath);
  return {
    id: disk.id,
    label: text(disk.label) || disk.id,
    kind: null,
    host: text(disk.lastHostId),
    sizeBytes: typeof disk.totalBytes === "number" ? disk.totalBytes : null,
    freeBytes: typeof disk.freeBytes === "number" ? disk.freeBytes : null,
    online: disk.online === true,
    lastSeen: text(disk.lastSeenAt),
    mount: mounts[0] || last,
    fs: text(disk.filesystem),
    location: null,
    fileCount: typeof disk.fileCount === "number" ? disk.fileCount : null,
  };
}

export function pcAgentOnline(channel) {
  if (!channel || typeof channel !== "object") return null;
  const peers = channel.peers;
  if (!peers || typeof peers !== "object") return null;
  const peer = peers["pc-agent"];
  if (!peer || typeof peer !== "object") return null;
  return peer.detail !== PC_AGENT_MISSING;
}

export function mapHosts(shelf, channel) {
  const hosts = new Map();
  const errors = new Map();
  for (const error of shelf?.agentErrors || []) {
    if (!error || !text(error.hostId)) continue;
    errors.set(error.hostId, text(error.message) || "");
    if (!hosts.has(error.hostId)) {
      hosts.set(error.hostId, {
        id: error.hostId,
        name: text(error.hostName) || error.hostId,
        online: false,
        error: text(error.message) || undefined,
      });
    }
  }
  for (const disk of shelf?.disks || []) {
    const id = text(disk?.lastHostId);
    if (!id) continue;
    const name = text(disk.lastHostName) || id;
    const failed = errors.has(id);
    const prev = hosts.get(id);
    if (!prev) {
      hosts.set(id, { id, name, online: !failed, error: failed ? errors.get(id) || undefined : undefined });
    } else {
      if (prev.name === id && name !== id) prev.name = name;
      if (failed) {
        prev.online = false;
        prev.error = errors.get(id) || prev.error;
      }
    }
  }
  const pc = pcAgentOnline(channel);
  if (pc !== null) {
    const prev = hosts.get("pc-agent");
    if (prev) prev.online = pc;
    else hosts.set("pc-agent", { id: "pc-agent", name: "pc-agent", online: pc });
  }
  return [...hosts.values()];
}

function typeFromCategories(categories) {
  if (!Array.isArray(categories)) return null;
  for (const category of categories) {
    if (Object.prototype.hasOwnProperty.call(CATEGORY_TYPE, category)) return CATEGORY_TYPE[category];
  }
  return null;
}

export function mapSearchHit(hit) {
  if (!hit || !text(hit.diskId) || typeof hit.name !== "string" || !hit.name) return null;
  const path = text(hit.path) || hit.name;
  return {
    id: `${hit.diskId}:${path}`,
    name: hit.name,
    diskId: hit.diskId,
    dir: "",
    path,
    type: typeFromCategories(hit.categories),
    contentId: `${hit.diskId}:${path}`,
    sizeBytes: null,
  };
}

export function mapBrowseEntry(entry) {
  if (!entry || !text(entry.diskId) || typeof entry.name !== "string" || !entry.name) return null;
  const path = text(entry.displayPath) || text(entry.relativePath) || entry.name;
  return {
    id: `${entry.diskId}:${path}`,
    name: entry.name,
    diskId: entry.diskId,
    dir: "",
    path,
    type: typeFromCategories(entry.categories),
    contentId: `${entry.diskId}:${path}`,
    sizeBytes: typeof entry.size === "number" ? entry.size : null,
  };
}

function mountsOf(disk) {
  const mounts = Array.isArray(disk?.mountPaths) ? disk.mountPaths.filter((item) => text(item)) : [];
  const last = text(disk?.lastMountPath);
  if (last) mounts.push(last);
  return mounts;
}

function pathOnMount(filePath, mount) {
  if (!filePath || !mount) return false;
  if (filePath === mount) return true;
  const sep = mount.includes("\\") ? "\\" : "/";
  const prefix = mount.endsWith(sep) ? mount : mount + sep;
  return filePath.startsWith(prefix);
}

export function matchDiskId(rawDisks, savePath) {
  if (!text(savePath)) return null;
  let best = null;
  for (const disk of rawDisks || []) {
    if (!text(disk?.id)) continue;
    for (const mount of mountsOf(disk)) {
      if (pathOnMount(savePath, mount) && (!best || mount.length > best.mount.length)) best = { id: disk.id, mount };
    }
  }
  return best ? best.id : null;
}

export function mapTorrent(torrent, rawDisks) {
  if (!torrent || !text(torrent.hash)) return null;
  const mapped = {
    id: torrent.hash,
    name: text(torrent.name) || "Без имени",
    diskId: matchDiskId(rawDisks, torrent.savePath),
    hostId: text(torrent.hostId),
    hostName: text(torrent.hostName),
    state: Object.prototype.hasOwnProperty.call(TORRENT_STATE, torrent.state) ? TORRENT_STATE[torrent.state] : null,
    progress: typeof torrent.progress === "number" ? Math.round(Math.min(1, Math.max(0, torrent.progress)) * 100) : null,
    sizeBytes: typeof torrent.totalSize === "number" ? torrent.totalSize : typeof torrent.size === "number" ? torrent.size : null,
    down: typeof torrent.dlspeed === "number" ? torrent.dlspeed / 1e6 : null,
    up: typeof torrent.upspeed === "number" ? torrent.upspeed / 1e6 : null,
    rank: null,
  };
  return mapped;
}

export function mapCopyJob(job) {
  if (!job || !text(job.id)) return null;
  const total = typeof job.bytesTotal === "number" ? job.bytesTotal : null;
  const done = typeof job.bytesDone === "number" ? job.bytesDone : null;
  const speed = typeof job.speed === "number" ? job.speed : null;
  let progress = null;
  if (total && total > 0 && done !== null) progress = Math.min(100, Math.round((done / total) * 100));
  else if (job.status === "completed") progress = 100;
  else if (done !== null || total !== null) progress = 0;
  let etaSec = null;
  if (speed && speed > 0 && total !== null && done !== null && total > done) etaSec = Math.ceil((total - done) / speed);
  const task = {
    id: job.id,
    kind: "copy",
    title: text(job.title) || job.id,
    host: null,
    progress,
    bytesPerSec: speed,
    etaSec,
    state: Object.prototype.hasOwnProperty.call(COPY_STATE, job.status) ? COPY_STATE[job.status] : null,
    error: text(job.error),
    totalBytes: total,
    source: "copy",
    progressId: `transfer__${job.id}`,
  };
  if (text(job.sourceSha256) || text(job.destSha256) || typeof job.verified === "boolean") {
    task.sha256 = {};
    if (text(job.sourceSha256)) task.sha256.source = job.sourceSha256;
    if (text(job.destSha256)) task.sha256.dest = job.destSha256;
    if (typeof job.verified === "boolean") task.sha256.verified = job.verified;
  }
  return task;
}

export function mapQueueJob(job) {
  if (!job || !text(job.id)) return null;
  const progress = job.progress && typeof job.progress === "object" ? job.progress : {};
  return {
    id: job.id,
    kind: text(job.kind),
    title: text(job.kind) || job.id,
    host: text(job.host),
    progress: typeof progress.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : null,
    bytesPerSec: typeof progress.speed === "number" ? progress.speed : null,
    etaSec: typeof progress.etaSeconds === "number" ? progress.etaSeconds : null,
    state: text(job.state),
    error: text(job.lastError),
    totalBytes: typeof progress.totalBytes === "number" ? progress.totalBytes : null,
    source: "queue",
  };
}

export function mapDestination(dest) {
  if (!dest || !text(dest.id) || !text(dest.label)) return null;
  return {
    id: dest.id,
    label: dest.label,
    online: dest.online === true,
    freeBytes: typeof dest.freeBytes === "number" ? dest.freeBytes : null,
    diskId: text(dest.diskId),
    detail: text(dest.detail),
  };
}

function mapQbHost(host) {
  if (!host || !text(host.id)) return null;
  return { id: host.id, name: text(host.name) || host.id, online: host.online === true };
}

export function assemble(input) {
  const drives = input?.drives || {};
  const unavailable = ["history", "disk.kind", "disk.location", "rules", "devices"];
  if (input?.channelMissing) unavailable.push("pc-agent");
  if (input?.torrentsMissing) unavailable.push("torrents");
  if (input?.copiesMissing) unavailable.push("copy");
  if (input?.jobsMissing) unavailable.push("jobs");
  if (input?.destinationsMissing) unavailable.push("destinations");
  const failedHosts = new Set((drives.agentErrors || []).map((error) => error?.hostId).filter((id) => text(id)));
  const disks = (Array.isArray(drives.disks) ? drives.disks : []).map(mapDisk).filter(Boolean);
  for (const disk of disks) if (disk.host && failedHosts.has(disk.host)) disk.online = false;
  const tasks = [];
  if (!input?.copiesMissing) {
    for (const job of input?.copies?.jobs || []) {
      const task = mapCopyJob(job);
      if (task) tasks.push(task);
    }
  }
  if (!input?.jobsMissing) {
    for (const job of input?.jobs?.jobs || []) {
      const task = mapQueueJob(job);
      if (task && !tasks.some((item) => item.id === task.id)) tasks.push(task);
    }
  }
  const rawDisks = Array.isArray(drives.disks) ? drives.disks : [];
  const torrents = input?.torrentsMissing
    ? []
    : (input?.torrents?.torrents || []).map((torrent) => mapTorrent(torrent, rawDisks)).filter(Boolean);
  return {
    hosts: mapHosts(drives, input?.channelMissing ? null : input?.channel || null),
    disks,
    files: [],
    torrents,
    tasks,
    history: [],
    rules: {},
    manifests: {},
    comparisons: [],
    devices: [],
    gamePool: null,
    imageDisk: null,
    loading: false,
    error: null,
    notices: (drives.agentErrors || []).map((error) => text(error?.message)).filter(Boolean),
    demo: false,
    automation: false,
    previewFresh: false,
    unavailable,
    torrentHosts: input?.torrentsMissing ? [] : (input?.torrents?.hosts || []).map(mapQbHost).filter(Boolean),
    destinations: input?.destinationsMissing ? [] : (input?.destinations?.destinations || []).map(mapDestination).filter(Boolean),
    copyUnavailable: Boolean(input?.copiesMissing),
    demoTransferRate: null,
  };
}

function aborted(error) {
  return Boolean(error && (error.name === "AbortError" || error.code === "ABORT_ERR"));
}

export async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store", headers: { accept: "application/json" } });
    const textBody = typeof response?.text === "function" ? await response.text() : "";
    let body = null;
    if (textBody) {
      try {
        body = JSON.parse(textBody);
      } catch {
        throw new PanelError("bad_json", "Ответ не JSON.", response?.status || 0);
      }
    }
    if (!response || response.ok !== true) {
      const message = body && typeof body.error === "string" && body.error ? body.error : "Панель ответила ошибкой.";
      throw new PanelError("http", message, response?.status || 0);
    }
    return body;
  } catch (error) {
    if (error instanceof PanelError) throw error;
    if (aborted(error)) throw new PanelError("timeout", "Панель не ответила вовремя.", 0);
    throw new PanelError("network", "Нет связи с панелью.", 0);
  } finally {
    clearTimeout(timer);
  }
}

async function settle(fetchImpl, url, timeoutMs) {
  try {
    return { ok: true, body: await fetchJson(fetchImpl, url, timeoutMs) };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function loadPanel(options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== "function") throw new PanelError("network", "Нет функции запроса.", 0);
  const timeoutMs = options.timeoutMs ?? 8000;
  const drives = await fetchJson(fetchImpl, "/api/drives", timeoutMs);
  if (drives && typeof drives.error === "string" && !Array.isArray(drives.disks)) {
    throw new PanelError("http", drives.error, 200);
  }
  const [copies, jobs, torrents, channel, destinations] = await Promise.all([
    settle(fetchImpl, "/api/files/copy", timeoutMs),
    settle(fetchImpl, "/api/jobs?limit=100", timeoutMs),
    settle(fetchImpl, "/api/torrents", timeoutMs),
    settle(fetchImpl, "/api/hosts/link", timeoutMs),
    settle(fetchImpl, "/api/files/destinations", timeoutMs),
  ]);
  return assemble({
    drives,
    copies: copies.ok ? copies.body : null,
    jobs: jobs.ok ? jobs.body : null,
    torrents: torrents.ok ? torrents.body : null,
    channel: channel.ok ? channel.body : null,
    destinations: destinations.ok ? destinations.body : null,
    copiesMissing: !copies.ok,
    jobsMissing: !jobs.ok,
    torrentsMissing: !torrents.ok,
    channelMissing: !channel.ok,
    destinationsMissing: !destinations.ok,
  });
}

export async function loadCatalog(fetchImpl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const query = typeof options.q === "string" ? options.q.trim() : "";
  if (query) {
    const body = await fetchJson(fetchImpl, `/api/drives/search?q=${encodeURIComponent(query)}&limit=100`, timeoutMs);
    return (Array.isArray(body?.hits) ? body.hits : []).map(mapSearchHit).filter(Boolean);
  }
  if (text(options.diskId)) {
    const body = await fetchJson(
      fetchImpl,
      `/api/drives/browse?diskId=${encodeURIComponent(options.diskId)}&limit=200`,
      timeoutMs,
    );
    return (Array.isArray(body?.entries) ? body.entries : []).map(mapBrowseEntry).filter(Boolean);
  }
  return [];
}

const api = {
  PanelError,
  demoEnabled,
  loadingSnapshot,
  mapDisk,
  mapHosts,
  pcAgentOnline,
  mapSearchHit,
  mapBrowseEntry,
  mapTorrent,
  mapCopyJob,
  mapQueueJob,
  mapDestination,
  matchDiskId,
  assemble,
  fetchJson,
  loadPanel,
  loadCatalog,
};

globalThis.PanelAdapter = api;
