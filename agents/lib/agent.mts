import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, open as openFs } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { systemCompactReason } from "../../src/addons/drives/compact-target.ts";
import { executeIndexPlan } from "../../src/addons/drives/execute-index.ts";
import { buildCompactArgv, DEFAULT_COMPACT_EXE } from "../../src/addons/media-games/compact.ts";
import { isCompactAlgorithm } from "../../src/addons/media-games/presets.ts";
import { selectIndexStrategy } from "../../src/addons/drives/strategy.ts";
import { normalizeSerial, normalizeUuid } from "../../src/addons/drives/identity.ts";
import type { CollectedVolume, HostOs, IndexPayload } from "../../src/addons/drives/types.ts";
import { readNtfsLetter, readUsn } from "./indexers.mts";
import { walkTree } from "./walk.mts";

export interface AgentCollectResult {
  elevated: boolean;
  volumes: CollectedVolume[];
  note: string;
}

interface TrackedVolume extends CollectedVolume {
  index: IndexPayload | null;
  indexedAt: number;
  usnStart: string | null;
  freeAtIndex: number;
}

interface AgentEvent {
  id: number;
  at: string;
  type: "attach" | "detach" | "index";
  serial: string;
  volumeUuid: string;
  filesystem?: string;
  mountPaths?: string[];
  progress?: number;
  state?: string;
  strategy?: string;
}


function volumeKey(volume: { serial: string; volumeUuid: string }): string {
  return `${volume.serial}|${volume.volumeUuid}`;
}

/** MFT snapshots that stored only $FILE_NAME lengths are all zeros. One rebuild picks up $DATA sizes. */
function snapshotHasNoSizes(index: IndexPayload | null | undefined): boolean {
  const files = index?.files;
  if (!files || files.length === 0) return false;
  let sawFile = false;
  for (const file of files) {
    if (file.kind === "dir") continue;
    sawFile = true;
    if (typeof file.size === "number" && file.size > 0) return false;
  }
  return sawFile;
}

/** Relative path only: no abs, no .., no NUL. Slash-normalized. */
function safeRelativePath(raw: string | null): string | null {
  if (!raw) return null;
  let value = String(raw).replace(/\\/g, "/").trim();
  if (!value || value.includes("\0")) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  if (/^[A-Za-z]:/.test(value)) return null;
  const parts = value.split("/").filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function letterKey(letter: string | null | undefined): string {
  const value = String(letter || "").replace(":", "").trim().toUpperCase();
  return /^[A-Z]$/.test(value) ? value : "";
}

function resolveVolumeFile(
  volumes: TrackedVolume[],
  serial: string | null,
  uuid: string | null,
  relativeRaw: string | null,
  os: HostOs,
): { absolute: string; relative: string; volume: TrackedVolume } | { error: string; status: number } {
  if (!uuid) return { error: "Нужен uuid тома.", status: 400 };
  // APFS may have empty serial. Windows may report \\?\Volume{uuid}\ while the panel stores bare uuid.
  const wantUuid = normalizeUuid(uuid);
  const wantSerial = serial ? normalizeSerial(serial) : "";
  if (!wantUuid) return { error: "Нужен uuid тома.", status: 400 };
  const volume = volumes.find((item) => {
    if (normalizeUuid(item.volumeUuid) !== wantUuid) return false;
    if (!wantSerial) return true;
    const have = normalizeSerial(item.serial);
    return !have || have === wantSerial;
  });
  if (!volume) return { error: "Том не подключён на этом хосте.", status: 404 };
  const relative = safeRelativePath(relativeRaw);
  if (!relative) return { error: "Путь должен быть относительным внутри тома.", status: 400 };
  const mount = volume.mountPaths[0];
  if (!mount) return { error: "У тома нет точки монтирования.", status: 409 };
  const joined = os === "win32"
    ? path.win32.resolve(mount, ...relative.split("/"))
    : path.posix.resolve(mount, ...relative.split("/"));
  const root = os === "win32" ? path.win32.resolve(mount) : path.posix.resolve(mount);
  const relToRoot = os === "win32" ? path.win32.relative(root, joined) : path.posix.relative(root, joined);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return { error: "Путь выходит за корень тома.", status: 400 };
  }
  return { absolute: joined, relative, volume };
}


function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) {
        reject(new Error("Слишком большой запрос."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object") reject(new Error("Пустое тело запроса."));
        else resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Не удалось разобрать запрос."));
      }
    });
    request.on("error", () => reject(new Error("Не удалось прочитать запрос.")));
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function startAgent(options: {
  port: number;
  hostId: string;
  hostName: string;
  os: HostOs;
  collect: () => Promise<AgentCollectResult>;
  mockIndex?: IndexPayload | null;
  intervalMs?: number;
}) {
  let elevated = false;
  let note = "";
  let volumes: TrackedVolume[] = [];
  const events: AgentEvent[] = [];
  let eventId = 0;
  const running = new Set<string>();
  const rebuiltEmptySizes = new Set<string>();
  const compactJobs = new Map<string, { id: string; state: "running" | "completed" | "failed"; error: string | null; message: string; path: string; algorithm: string }>();
  let ticking = false;
  let restoreFailed = false;
  const manualOnly = new Set<string>();
  const exclude = new Set<string>();
  function volumeLetter(volume: { letter?: string | null; mountPaths?: string[] }): string {
    return letterKey(volume.letter) || letterKey((volume.mountPaths?.[0] || "").slice(0, 2));
  }
  function isExcludedVolume(volume: { letter?: string | null; mountPaths?: string[]; volumeUuid?: string }): boolean {
    const letter = volumeLetter(volume);
    if (letter && exclude.has(letter)) return true;
    const uuid = normalizeUuid(volume.volumeUuid || "");
    return Boolean(uuid && exclude.has(uuid));
  }
  function isManualVolume(volume: { letter?: string | null; mountPaths?: string[] }): boolean {
    const letter = volumeLetter(volume);
    return Boolean(letter && manualOnly.has(letter));
  }
  const snapshotPath = process.env.SKLAD_AGENT_SNAPSHOT || path.join(process.cwd(), "data", "drive-agent-snapshot.json.gz");
  let persistChain: Promise<unknown> = Promise.resolve();
  function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const data = await promisify(gzip)(JSON.stringify({ volumes }));
      await writeFile(`${snapshotPath}.tmp`, data);
      await rename(`${snapshotPath}.tmp`, snapshotPath);
    }).catch((error) => { note = `Не удалось сохранить индекс: ${String(error)}`; });
  }
  const ready = (async () => {
    try {
      const disabledPath = process.env.SKLAD_AGENT_DISABLED || path.join(process.cwd(), "data", "drive-agent-disabled.json");
      const data = JSON.parse(await readFile(disabledPath, "utf8")) as { letters?: unknown; exclude?: unknown };
      for (const letter of Array.isArray(data.letters) ? data.letters : []) {
        const key = letterKey(String(letter));
        if (key) manualOnly.add(key);
      }
      for (const item of Array.isArray(data.exclude) ? data.exclude : []) {
        const text = String(item).trim();
        const key = letterKey(text);
        if (key) exclude.add(key);
        else {
          const uuid = normalizeUuid(text);
          if (uuid) exclude.add(uuid);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") note = "Не удалось прочитать исключения дисков."; }
    try {
      const saved = JSON.parse((await promisify(gunzip)(await readFile(snapshotPath))).toString());
      volumes = (saved.volumes ?? []).map((v: TrackedVolume) => ({ ...v, indexedAt: v.indexedAt || Date.now(), freeAtIndex: v.freeBytes, usnStart: v.usnStart ?? null }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { restoreFailed = true; note = "Снимок повреждён: автоматическое сканирование отключено, нужен ручной запуск."; } }
  })();

  function pushEvent(event: Omit<AgentEvent, "id" | "at">) {
    eventId += 1;
    events.push({ ...event, id: eventId, at: new Date().toISOString() });
    if (events.length > 400) events.shift();
  }

  async function indexVolume(volume: TrackedVolume, sizeRebuild = false, manual = false) {
    const key = volumeKey(volume);
    if (running.has(key) || isExcludedVolume(volume)) return;
    if (!manual && isManualVolume(volume)) return;
    if (sizeRebuild) rebuiltEmptySizes.add(key);
    running.add(key);
    const previousIndex = volume.index;
    volume.index = {
      ...previousIndex,
      state: volume.busy ? "paused" : "running",
      progress: volume.index?.progress ?? 0,
      strategy: selectIndexStrategy({
        filesystem: volume.filesystem,
        platform: options.os,
        elevated,
      }).strategy,
    };
    try {
      const result = await executeIndexPlan(
        {
          filesystem: volume.filesystem,
          platform: options.os,
          elevated,
          busy: volume.busy,
          // fsutil text has leaf names, not reliable full paths. Do not publish it
          // as a complete delta; explicit manual refresh uses a complete tree.
          usnCheckpoint: false,
        },
        {
          readMft: () => readNtfsLetter(volume.letter ?? ""),
          readUsn: async () => {
            const journal = await readUsn(volume.letter ?? "", volume.usnStart);
            if (journal.nextUsn) volume.usnStart = journal.nextUsn;
            return { delta: journal.delta };
          },
          walk: () => walkTree(volume.mountPaths[0] ?? ""),
        },
      );
      if (result.payload.state === "complete" && result.payload.files) {
        result.payload.revision = randomUUID();
        result.payload.recordCount = result.payload.files.length;
      }
      // A pause/error is metadata, never a destructive replacement of the last tree.
      volume.index = { ...previousIndex, ...result.payload };
      if (result.payload.state === "complete") persist();
      volume.indexedAt = Date.now();
      volume.freeAtIndex = volume.freeBytes;
      pushEvent({
        type: "index",
        serial: volume.serial,
        volumeUuid: volume.volumeUuid,
        filesystem: volume.filesystem,
        progress: result.payload.progress,
        state: result.payload.state,
        strategy: result.payload.strategy,
      });
    } catch (error) {
      volume.index = { ...previousIndex, state: "error", progress: previousIndex?.progress ?? 0, message: String(error) };
    } finally {
      running.delete(key);
    }
  }

  async function tick() {
    await ready;
    if (ticking) return;
    ticking = true;
    try { await collectAndIndex(); } finally { ticking = false; }
  }

  async function collectAndIndex() {
    let collected: AgentCollectResult;
    try {
      collected = await options.collect();
    } catch (error) {
      note = error instanceof Error ? error.message : "Сбор томов не выполнился.";
      return;
    }
    elevated = collected.elevated;
    note = collected.note;
    const previous = new Map(volumes.map((volume) => [volumeKey(volume), volume]));
    const next: TrackedVolume[] = [];
    for (const volume of collected.volumes) {
      const key = volumeKey(volume);
      const prior = previous.get(key);
      if (!prior) {
        pushEvent({
          type: "attach",
          serial: volume.serial,
          volumeUuid: volume.volumeUuid,
          filesystem: volume.filesystem,
          mountPaths: volume.mountPaths,
        });
      }
      // Keep object identity while an asynchronous index job owns this volume.
      const tracked = prior ?? { ...volume, index: options.mockIndex ?? null, indexedAt: 0, usnStart: null, freeAtIndex: -1 };
      Object.assign(tracked, volume);
      next.push(tracked);
      previous.delete(key);
    }
    for (const gone of previous.values()) {
      pushEvent({ type: "detach", serial: gone.serial, volumeUuid: gone.volumeUuid, filesystem: gone.filesystem });
    }
    volumes = next;
    if (options.mockIndex) return;
    for (const volume of volumes) {
      // Complete snapshots do not expire. Free-space changes are not proof of a
      // pathname change; never turn a UI refresh into another full MFT read.
      // A snapshot whose every file is 0 bytes is the old $FILE_NAME reader and is rebuilt once.
      const key = volumeKey(volume);
      const rebuildSizes = snapshotHasNoSizes(volume.index) && !rebuiltEmptySizes.has(key);
      const needs = !restoreFailed && !isExcludedVolume(volume) && !isManualVolume(volume) && !volume.busy &&
        (!volume.index || (volume.index.state === "paused" && !volume.index.files) || rebuildSizes);
      if (needs) void indexVolume(volume, rebuildSizes);
    }
  }

  function resolveTracked(serial: string | null, uuid: string | null, relative: string | null) {
    const resolved = resolveVolumeFile(volumes, serial, uuid, relative, options.os);
    if ("error" in resolved) return resolved;
    if (isExcludedVolume(resolved.volume)) return { error: "Том исключён в конфиге агента.", status: 403 as const };
    return resolved;
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      send(response, 200, { ok: true, hostId: options.hostId, os: options.os, elevated, note });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/compact") {
      const job = compactJobs.get(url.searchParams.get("id") || "");
      if (!job) { send(response, 404, { error: "Задание сжатия не найдено." }); return; }
      send(response, 200, job);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/compact") {
      void (async () => {
        try {
          const body = await readJsonBody(request);
          if (body.confirm !== true) { send(response, 400, { error: "Нужно явное подтверждение. Сжатие не запускалось." }); return; }
          if (options.os !== "win32" || process.platform !== "win32") {
            send(response, 400, { error: "Сжатие Windows запускается только на самом ПК. Здесь оно не начато." });
            return;
          }
          if (!elevated) { send(response, 403, { error: "Агент без прав администратора. CompactGUI/WOF не запускался." }); return; }
          const algorithm = String(body.algorithm || "");
          if (!isCompactAlgorithm(algorithm)) { send(response, 400, { error: "Неизвестный алгоритм. Сжатие не запускалось." }); return; }
          const resolved = resolveTracked(String(body.serial || ""), String(body.uuid || ""), String(body.path || ""));
          if ("error" in resolved) { send(response, resolved.status, { error: `${resolved.error} Сжатие не запускалось.` }); return; }
          if (!/ntfs/i.test(resolved.volume.filesystem)) {
            send(response, 400, { error: "Том не NTFS. Сжатие не запускалось." });
            return;
          }
          const blocked = systemCompactReason(resolved.absolute);
          if (blocked) { send(response, 400, { error: `${blocked} Сжатие не запускалось.` }); return; }
          let info;
          try { info = statSync(resolved.absolute); } catch {
            send(response, 404, { error: "Папка не найдена на томе. Сжатие не запускалось." });
            return;
          }
          if (!info.isDirectory()) { send(response, 400, { error: "Сжимать можно только папку. Сжатие не запускалось." }); return; }
          const binary = DEFAULT_COMPACT_EXE;
          if (!existsSync(binary)) { send(response, 500, { error: "Программа сжатия Windows не найдена. Сжатие не запускалось." }); return; }
          const argv = buildCompactArgv({ os: "win32", binary, folder: resolved.absolute, algorithm });
          const id = randomUUID();
          const job = { id, state: "running" as const, error: null, message: "Сжатие выполняется.", path: resolved.absolute, algorithm };
          compactJobs.set(id, job);
          const child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
          });
          child.on("error", () => {
            compactJobs.set(id, { ...job, state: "failed", error: "Не удалось запустить сжатие Windows.", message: "Сжатие не выполнилось." });
          });
          child.on("exit", (code) => {
            if (code === 0) {
              compactJobs.set(id, { ...job, state: "completed", error: null, message: "Сжатие завершилось. Размеры обновятся после перечитывания MFT." });
              void indexVolume(resolved.volume);
            } else {
              compactJobs.set(id, { ...job, state: "failed", error: stderr.trim() || `Сжатие завершилось с кодом ${code}.`, message: "Сжатие не выполнилось." });
            }
          });
          send(response, 202, job);
        } catch (error) {
          send(response, 400, { error: error instanceof Error ? error.message : "Сжатие не запускалось." });
        }
      })();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rescan") {
      const volume = volumes.find((v) => v.serial === url.searchParams.get("serial") && v.volumeUuid === url.searchParams.get("uuid"));
      if (!volume || isExcludedVolume(volume)) { send(response, 404, { error: "Том исключён в конфиге агента." }); return; }
      if (running.has(volumeKey(volume)) || volume.busy) { send(response, 409, { error: "Том занят." }); return; }
      void indexVolume(volume, false, true);
      send(response, 202, { accepted: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/files") {
      const volume = volumes.find((v) => v.serial === url.searchParams.get("serial") && v.volumeUuid === url.searchParams.get("uuid"));
      if (!volume || isExcludedVolume(volume)) { send(response, 404, { error: "Том исключён в конфиге агента." }); return; }
      const index = volume.index;
      if (!index?.files || index.revision !== url.searchParams.get("revision")) { send(response, 409, { error: "Снимок изменился." }); return; }
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const limit = Math.min(10000, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 10000)));
      send(response, 200, { revision: index.revision, total: index.files.length, files: index.files.slice(offset, offset + limit) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/volumes") {
      send(response, 200, {
        hostId: options.hostId,
        hostName: options.hostName,
        os: options.os,
        elevated,
        note,
        volumes: volumes.filter((volume) => !isExcludedVolume(volume)).map((volume) => ({
          manualOnly: isManualVolume(volume),
          serial: volume.serial,
          volumeUuid: volume.volumeUuid,
          filesystem: volume.filesystem,
          volumeName: volume.volumeName,
          mountPaths: volume.mountPaths,
          totalBytes: volume.totalBytes,
          freeBytes: volume.freeBytes,
          busy: volume.busy,
          letter: volume.letter,
          index: !volume.index ? null : {
            state: volume.index.state, progress: volume.index.progress,
            message: volume.index.message, strategy: volume.index.strategy,
            revision: volume.index.revision,
            recordCount: volume.index.files?.length ?? volume.index.recordCount ?? 0,
            ...(url.searchParams.get("files") === "1" ? { files: volume.index.files, delta: volume.index.delta } : {}),
          },
        })),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const since = Number(url.searchParams.get("since") || "0");
      send(response, 200, { events: events.filter((event) => event.id > since) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/file/stat") {
      const resolved = resolveTracked(url.searchParams.get("serial"), url.searchParams.get("uuid"), url.searchParams.get("path"));
      if ("error" in resolved) { send(response, resolved.status, { error: resolved.error }); return; }
      try {
        const info = statSync(resolved.absolute);
        if (!info.isFile()) { send(response, 404, { error: "Это не файл." }); return; }
        send(response, 200, {
          ok: true,
          size: info.size,
          mtimeMs: info.mtimeMs,
          relativePath: resolved.relative,
          mountPath: resolved.volume.mountPaths[0] || "",
        });
      } catch {
        send(response, 404, { error: "Файл не найден на томе." });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/file/content") {
      const resolved = resolveTracked(url.searchParams.get("serial"), url.searchParams.get("uuid"), url.searchParams.get("path"));
      if ("error" in resolved) { send(response, resolved.status, { error: resolved.error }); return; }
      let info;
      try {
        info = statSync(resolved.absolute);
      } catch {
        send(response, 404, { error: "Файл не найден на томе." });
        return;
      }
      if (!info.isFile()) { send(response, 404, { error: "Это не файл." }); return; }
      const hash = createHash("sha256");
      const stream = createReadStream(resolved.absolute);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(info.size),
        "cache-control": "no-store",
        "x-sklad-relative-path": encodeURIComponent(resolved.relative),
        "x-sklad-size": String(info.size),
      });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", () => {
        if (!response.headersSent) send(response, 500, { error: "Чтение файла прервалось." });
        else response.destroy();
      });
      stream.on("end", () => {
        try { response.setHeader("x-sklad-sha256", hash.digest("hex")); } catch { /* headers already flushed */ }
      });
      // Expose digest via trailer-like side channel: panel also hashes the body.
      // After stream ends, write nothing more — panel computes its own SHA of bytes received.
      stream.pipe(response);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/v1/file/content") {
      const resolved = resolveTracked(url.searchParams.get("serial"), url.searchParams.get("uuid"), url.searchParams.get("path"));
      if ("error" in resolved) { send(response, resolved.status, { error: resolved.error }); return; }
      // Refuse overwrite unless explicit
      const overwrite = url.searchParams.get("overwrite") === "1";
      if (existsSync(resolved.absolute) && !overwrite) {
        send(response, 409, { error: "Файл уже есть. Перезапись не включена." });
        return;
      }
      const dir = options.os === "win32" ? path.win32.dirname(resolved.absolute) : path.posix.dirname(resolved.absolute);
      const root = options.os === "win32"
        ? path.win32.resolve(resolved.volume.mountPaths[0] || "")
        : path.posix.resolve(resolved.volume.mountPaths[0] || "");
      const tmp = `${resolved.absolute}.sklad-part`;
      void (async () => {
        try {
          // Windows rejects mkdir on the drive root (EPERM on "S:\\").
          const resolvedDir = options.os === "win32" ? path.win32.resolve(dir) : path.posix.resolve(dir);
          if (resolvedDir !== root) await mkdir(dir, { recursive: true });
          const hash = createHash("sha256");
          let bytes = 0;
          const hasher = new Transform({
            transform(chunk, _enc, cb) {
              hash.update(chunk);
              bytes += chunk.length;
              cb(null, chunk);
            },
          });
          await pipeline(request, hasher, createWriteStream(tmp));
          const digest = hash.digest("hex");
          // Independent verify: re-hash the written temp file
          const verify = createHash("sha256");
          const fd = await openFs(tmp, "r");
          try {
            const stream = fd.createReadStream();
            for await (const chunk of stream) verify.update(chunk);
          } finally {
            await fd.close();
          }
          const writtenDigest = verify.digest("hex");
          if (writtenDigest !== digest) {
            try { await rename(tmp, `${tmp}.bad`); } catch { /* keep tmp */ }
            send(response, 500, { error: "Контрольная сумма записи не совпала." });
            return;
          }
          await rename(tmp, resolved.absolute);
          send(response, 200, {
            ok: true,
            bytes,
            sha256: writtenDigest,
            relativePath: resolved.relative,
          });
        } catch (error) {
          send(response, 500, { error: error instanceof Error ? error.message : "Запись не удалась." });
        }
      })();
      return;
    }

    send(response, 404, { error: "Неизвестный путь агента." });
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(`${options.hostName} слушает 0.0.0.0:${options.port}`);
  });
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? 4000);
  timer.unref?.();
  server.once("close", () => clearInterval(timer));
  return server;
}
