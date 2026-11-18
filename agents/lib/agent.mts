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
import { applyRawDelta, indexMode, type VolumeWatch, type VolumeWatchEvent } from "../../src/addons/drives/index-mode.ts";
import { selectIndexStrategy } from "../../src/addons/drives/strategy.ts";
import { normalizeSerial, normalizeUuid } from "../../src/addons/drives/identity.ts";
import { isServiceVolume } from "../../src/addons/drives/inventory.ts";
import { chunkGapMs, defaultIndexPolicy, emptyCheckpoint, mergeIndexFiles, normalizeIndexPolicy, type IndexLoadPolicy } from "../../src/addons/drives/index-session.ts";
import { loadVolumeGuard, matchesExcluded, isIgnoredVolume, type VolumeGuard } from "../../src/addons/drives/volume-guard.ts";
import type { CollectedVolume, HostOs, IndexPayload, IndexPauseReason, RawIndexedFile } from "../../src/addons/drives/types.ts";
import { readNtfsLetter, readUsn, type DirStub } from "./indexers.mts";
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
  lastEventId: string | null;
  journalLost?: boolean;
  pendingDelta?: IndexPayload["delta"];
  pendingCursor?: string | null;
  freeAtIndex: number;
  priority?: number;
  signal?: { pause: boolean; cancel: boolean; reason: IndexPauseReason | null };
  partialFiles?: RawIndexedFile[];
  dirStubs?: DirStub[];
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


function signaled(signal: { pause: boolean; cancel: boolean; reason?: IndexPauseReason | null } | undefined, key: "pause" | "cancel"): boolean {
  return signal?.[key] === true;
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
  /** Ignored. Disk indexing is not on a timer. */
  intervalMs?: number;
  watch?: VolumeWatch;
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
  let policy: IndexLoadPolicy = defaultIndexPolicy();
  let guard: VolumeGuard = { manualOnly: new Set(), excludeLetters: new Set(), excludeUuids: new Set(), excludeSerials: new Set() };
  function isExcludedVolume(volume: { letter?: string | null; mountPaths?: string[]; volumeUuid?: string; serial?: string }): boolean {
    return matchesExcluded(guard, volume);
  }
  function isManualVolume(volume: { letter?: string | null; mountPaths?: string[] }): boolean {
    const letter = letterKey(volume.letter) || letterKey((volume.mountPaths?.[0] || "").slice(0, 2));
    return Boolean(letter && guard.manualOnly.has(letter));
  }
  const snapshotPath = process.env.SKLAD_AGENT_SNAPSHOT || path.join(process.cwd(), "data", "drive-agent-snapshot.json.gz");
  let persistChain: Promise<unknown> = Promise.resolve();
  function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const data = await promisify(gzip)(JSON.stringify({ volumes, policy }));
      await writeFile(`${snapshotPath}.tmp`, data);
      await rename(`${snapshotPath}.tmp`, snapshotPath);
    }).catch((error) => { note = `Не удалось сохранить индекс: ${String(error)}`; });
  }
  const ready = (async () => {
    try {
      guard = await loadVolumeGuard();
      process.env.SKLAD_EXCLUDE_LETTERS = [...guard.excludeLetters].join(",");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") note = "Не удалось прочитать исключения дисков."; }
    try {
      const saved = JSON.parse((await promisify(gunzip)(await readFile(snapshotPath))).toString());
      policy = normalizeIndexPolicy(saved.policy);
      volumes = (saved.volumes ?? [])
        .filter((volume: TrackedVolume) => !isExcludedVolume(volume) && !isIgnoredVolume(volume))
        .map((volume: TrackedVolume) => {
          const next: TrackedVolume = {
            ...volume,
            indexedAt: volume.indexedAt || Date.now(),
            freeAtIndex: volume.freeBytes,
            usnStart: volume.usnStart ?? null,
            lastEventId: typeof volume.lastEventId === "string" ? volume.lastEventId : null,
            partialFiles: volume.partialFiles ?? [],
            dirStubs: volume.dirStubs ?? [],
            signal: { pause: false, cancel: false, reason: null },
          };
          if (next.index?.state === "running") {
            next.index = {
              ...next.index,
              state: "paused",
              pauseReason: "restart",
              message: "Пауза после перезапуска. Продолжение с места остановки.",
            };
          }
          return next;
        });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { restoreFailed = true; note = "Снимок повреждён: автоматическое сканирование отключено, нужен ручной запуск."; } }
  })();

  function pushEvent(event: Omit<AgentEvent, "id" | "at">) {
    eventId += 1;
    events.push({ ...event, id: eventId, at: new Date().toISOString() });
    if (events.length > 400) events.shift();
  }

  async function indexVolume(volume: TrackedVolume, sizeRebuild = false, manual = false, fresh = manual || sizeRebuild, mode: "catalog" | "usn" | "fsevents" = "catalog") {
    const key = volumeKey(volume);
    if (running.has(key) || isExcludedVolume(volume) || isIgnoredVolume(volume)) return;
    if (!manual && isManualVolume(volume)) return;
    if (sizeRebuild) rebuiltEmptySizes.add(key);
    if (fresh) {
      volume.partialFiles = [];
      volume.dirStubs = [];
      volume.usnStart = null;
      volume.lastEventId = null;
      volume.journalLost = false;
    }
    let redoFull = false;
    running.add(key);
    const signal = volume.signal ?? { pause: false, cancel: false, reason: null };
    signal.pause = false;
    signal.cancel = false;
    signal.reason = null;
    volume.signal = signal;
    const previousIndex = volume.index;
    const cursor = fresh ? emptyCheckpoint() : (volume.index?.checkpoint ?? emptyCheckpoint());
    volume.index = {
      ...previousIndex,
      state: volume.busy ? "paused" : "running",
      progress: fresh ? 0 : (volume.index?.progress ?? 0),
      strategy: selectIndexStrategy({
        filesystem: volume.filesystem,
        platform: options.os,
        elevated,
      }).strategy,
      checkpoint: cursor,
      pauseReason: null,
    };
    try {
      const result = await executeIndexPlan(
        {
          filesystem: volume.filesystem,
          platform: options.os,
          elevated,
          busy: volume.busy,
          usnCheckpoint: mode === "usn",
          incremental: mode === "catalog" ? undefined : mode,
          cursor: { ...cursor, nextUsn: volume.usnStart },
        },
        {
          readMft: () => readNtfsLetter(volume.letter ?? "", {
            startRecord: cursor.recordsDone,
            carry: volume.dirStubs ?? [],
            shouldPause: () => signaled(volume.signal, "pause") || signaled(volume.signal, "cancel"),
            gapMs: chunkGapMs(policy),
          }),
          readUsn: async () => {
            const journal = await readUsn(volume.letter ?? "", volume.usnStart);
            if (journal.nextUsn) volume.usnStart = journal.nextUsn;
            return { delta: journal.delta };
          },
          walk: () => walkTree(volume.mountPaths[0] ?? ""),
          readEvents: async () => ({
            delta: volume.pendingDelta ?? { upserts: [], deletes: [], complete: true },
            cursor: volume.pendingCursor ?? volume.lastEventId,
            lost: volume.journalLost === true,
          }),
        },
      );
      if (result.cursor) volume.lastEventId = result.cursor;
      if (result.journalLost) {
        volume.journalLost = true;
        volume.usnStart = null;
        volume.lastEventId = null;
        redoFull = mode !== "catalog";
      } else if (result.payload.state === "complete" && result.payload.delta && !result.payload.files) {
        result.payload.files = applyRawDelta(previousIndex?.files ?? [], result.payload.delta);
      }
      const cancelled = signaled(volume.signal, "cancel");
      const pausedByUser = signaled(volume.signal, "pause");
      const reason: IndexPauseReason | null = cancelled
        ? null
        : pausedByUser
          ? volume.signal?.reason ?? "user"
          : result.payload.pauseReason ?? null;
      const stopEarly = cancelled || (result.payload.state !== "complete" && (result.payload.state === "paused" || pausedByUser));
      if (stopEarly) {
        const merged = mergeIndexFiles(previousIndex?.files ?? [], volume.partialFiles ?? [], result.payload.files ?? [], false);
        volume.partialFiles = merged.partial;
        if (result.dirs) volume.dirStubs = result.dirs;
        volume.index = {
          ...previousIndex,
          ...result.payload,
          state: cancelled ? "error" : "paused",
          pauseReason: cancelled ? null : reason ?? "user",
          cancelled,
          message: cancelled
            ? "Отменено. Файлы пользователя не удалялись."
            : result.payload.message || "Индексация на паузе. Продолжение с места остановки.",
          files: previousIndex?.files?.length ? previousIndex.files : undefined,
          checkpoint: result.payload.checkpoint ?? cursor,
        };
        persist();
      } else if (result.payload.state === "complete") {
        const merged = mergeIndexFiles(previousIndex?.files ?? [], volume.partialFiles ?? [], result.payload.files ?? [], true);
        volume.partialFiles = [];
        volume.dirStubs = [];
        result.payload.files = merged.published;
        result.payload.revision = randomUUID();
        result.payload.recordCount = merged.published.length;
        result.payload.checkpoint = {
          recordsDone: result.payload.checkpoint?.recordsDone ?? cursor.recordsDone,
          recordsTotal: result.payload.checkpoint?.recordsTotal ?? null,
          mftOffset: null,
          nextUsn: volume.usnStart,
        };
        volume.index = { ...previousIndex, ...result.payload, pauseReason: null, cancelled: false };
        persist();
      } else {
        volume.index = { ...previousIndex, ...result.payload, files: previousIndex?.files };
        persist();
      }
      volume.indexedAt = Date.now();
      volume.freeAtIndex = volume.freeBytes;
      pushEvent({
        type: "index",
        serial: volume.serial,
        volumeUuid: volume.volumeUuid,
        filesystem: volume.filesystem,
        progress: result.payload.progress,
        state: volume.index?.state ?? result.payload.state,
        strategy: result.payload.strategy,
      });
    } catch (error) {
      volume.index = { ...previousIndex, state: "error", progress: previousIndex?.progress ?? 0, message: String(error), files: previousIndex?.files };
    } finally {
      running.delete(key);
      volume.pendingDelta = undefined;
      if (volume.signal) {
        volume.signal.pause = false;
        volume.signal.cancel = false;
      }
      if (redoFull) void indexVolume(volume, false, true, true, "catalog");
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
      if (isExcludedVolume(volume)) continue;
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
      const tracked = prior ?? { ...volume, index: options.mockIndex ?? null, indexedAt: 0, usnStart: null, lastEventId: null, freeAtIndex: -1 };
      Object.assign(tracked, volume);
      next.push(tracked);
      previous.delete(key);
    }
    for (const gone of previous.values()) {
      pushEvent({ type: "detach", serial: gone.serial, volumeUuid: gone.volumeUuid, filesystem: gone.filesystem });
    }
    volumes = next;
    if (options.mockIndex) return;
    const quiet = policy.quiet || policy.quietHours.some((window) => {
      const hour = new Date().getHours();
      return window.startHour < window.endHour ? hour >= window.startHour && hour < window.endHour : hour >= window.startHour || hour < window.endHour;
    });
    const candidates: Array<{ volume: TrackedVolume; rebuildSizes: boolean; fresh: boolean; mode: "catalog" | "usn" | "fsevents" }> = [];
    for (const volume of volumes) {
      // Complete snapshots do not expire. Free-space changes are not proof of a
      // pathname change; never turn a UI refresh into another full MFT read.
      // A snapshot whose every file is 0 bytes is the old $FILE_NAME reader and is rebuilt once.
      const key = volumeKey(volume);
      const rebuildSizes = snapshotHasNoSizes(volume.index) && !rebuiltEmptySizes.has(key);
      const reason = volume.index?.pauseReason;
      const held = reason === "user" || reason === "restart";
      if (isExcludedVolume(volume) || isIgnoredVolume(volume) || held || signaled(volume.signal, "pause")) continue;
      if (quiet || volume.busy) {
        if (volume.index?.state === "running" && volume.signal) {
          volume.signal.pause = true;
          volume.signal.reason = quiet ? "quiet" : "busy";
        }
        if (volume.index && volume.index.state !== "complete") {
          volume.index = { ...volume.index, state: "paused", pauseReason: quiet ? "quiet" : "busy" };
        }
        continue;
      }
      const continueHeld = reason === "quiet" || reason === "busy";
      const needs = !restoreFailed && !isManualVolume(volume) && !isServiceVolume(volume) && !volume.busy &&
        (rebuildSizes || !volume.index || (volume.index.state === "paused" && !volume.index.files) || continueHeld);
      if (needs) candidates.push({ volume, rebuildSizes, fresh: rebuildSizes, mode: "catalog" });
      else if (!restoreFailed && !isManualVolume(volume) && !isServiceVolume(volume)) {
        const mode = indexMode({
          filesystem: volume.filesystem,
          platform: options.os,
          hasCatalog: volume.index?.state === "complete" && (volume.index.files?.length ?? 0) > 0,
          usnCursor: volume.usnStart,
          lastEventId: volume.lastEventId,
          journalLost: volume.journalLost === true,
          reason: "restart",
        });
        if (mode === "usn" || mode === "fsevents") candidates.push({ volume, rebuildSizes: false, fresh: false, mode });
      }
    }
    candidates.sort((left, right) => (right.volume.priority ?? 0) - (left.volume.priority ?? 0));
    let slots = running.size;
    const limit = Math.max(1, policy.parallelism);
    for (const item of candidates) {
      if (slots >= limit) break;
      if (running.has(volumeKey(item.volume))) continue;
      slots += 1;
      void indexVolume(item.volume, item.rebuildSizes, false, item.fresh, item.mode);
    }
  }

  function volumeMatches(volume: TrackedVolume, event: VolumeWatchEvent): boolean {
    if (event.serial && event.volumeUuid) return volume.serial === event.serial && volume.volumeUuid === event.volumeUuid;
    if (event.letter && volume.letter && volume.letter === event.letter) return true;
    if (event.mount) return volume.mountPaths.some((mount) => mount === event.mount || event.mount?.startsWith(`${mount.replace(/[\\/]+$/, "")}/`) || event.mount?.startsWith(mount));
    return false;
  }

  async function applyWatch(event: VolumeWatchEvent) {
    await ready;
    const match = volumes.find((volume) => volumeMatches(volume, event));
    if (event.type === "detach") {
      if (!match) return;
      volumes = volumes.filter((volume) => volume !== match);
      pushEvent({ type: "detach", serial: match.serial, volumeUuid: match.volumeUuid, filesystem: match.filesystem });
      persist();
      return;
    }
    if (event.type === "cursor" && event.cursor) {
      const targets = match ? [match] : volumes;
      for (const volume of targets) volume.lastEventId = event.cursor;
      if (targets.length) persist();
      return;
    }
    if (event.type === "attach") {
      await collectAndIndex();
      return;
    }
    if (!match) return;
    if (event.type === "journal-lost") {
      match.journalLost = true;
      void indexVolume(match, false, true, true, "catalog");
      return;
    }
    if (event.type === "journal") {
      match.pendingDelta = event.delta ?? { upserts: [], deletes: [], complete: true };
      match.pendingCursor = event.cursor ?? match.lastEventId;
      const mode = indexMode({
        filesystem: match.filesystem,
        platform: options.os,
        hasCatalog: match.index?.state === "complete" && (match.index.files?.length ?? 0) > 0,
        usnCursor: match.usnStart,
        lastEventId: event.cursor ?? match.lastEventId,
        journalLost: false,
        reason: "change",
      });
      if (mode === "usn" || mode === "fsevents") void indexVolume(match, false, false, false, mode);
      else if (mode === "mft" || mode === "walk") void indexVolume(match, false, true, true, "catalog");
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
    if (request.method === "GET" && url.pathname === "/v1/index/progress") {
      const jobs = volumes.filter((volume) => !isExcludedVolume(volume) && !isIgnoredVolume(volume)).map((volume) => ({
        id: volumeKey(volume),
        serial: volume.serial,
        volumeUuid: volume.volumeUuid,
        label: volume.volumeName,
        state: volume.index?.state ?? "idle",
        pauseReason: volume.index?.pauseReason ?? null,
        progress: volume.index?.progress ?? 0,
        strategy: volume.index?.strategy ?? null,
        currentFile: volume.index?.currentFile ?? null,
        processedBytes: volume.index?.processedBytes ?? 0,
        totalBytes: volume.index?.totalBytes ?? volume.totalBytes,
        speed: volume.index?.speed ?? 0,
        eta: volume.index?.eta ?? null,
        priority: volume.priority ?? 0,
        checkpoint: volume.index?.checkpoint ?? null,
      }));
      const processedBytes = jobs.reduce((sum, job) => sum + (job.processedBytes || 0), 0);
      const totalBytes = jobs.reduce((sum, job) => sum + Math.max(job.totalBytes || 0, job.processedBytes || 0), 0);
      send(response, 200, {
        policy,
        queue: { progress: totalBytes > 0 ? processedBytes / totalBytes : 0, processedBytes, totalBytes },
        jobs,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/index/policy") {
      void (async () => {
        try {
          policy = normalizeIndexPolicy({ ...policy, ...(await readJsonBody(request)) });
          persist();
          send(response, 200, policy);
        } catch {
          send(response, 400, { error: "Политика индексации не сохранилась." });
        }
      })();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/index/control") {
      void (async () => {
        try {
          const body = await readJsonBody(request);
          const action = String(body.action || "");
          const all = action === "pause-all" || action === "resume-all" || action === "cancel-all";
          const targets = all
            ? volumes.filter((volume) => !isExcludedVolume(volume) && !isIgnoredVolume(volume))
            : volumes.filter((volume) => volume.serial === String(body.serial || "") && volume.volumeUuid === String(body.uuid || "") && !isExcludedVolume(volume) && !isIgnoredVolume(volume));
          if (!all && targets.length === 0) { send(response, 404, { error: "Том исключён или не найден. Индексация не менялась." }); return; }
          for (const volume of targets) {
            if (action === "pause" || action === "pause-all") {
              volume.signal = volume.signal ?? { pause: false, cancel: false, reason: null };
              volume.signal.pause = true;
              volume.signal.reason = "user";
              volume.index = {
                ...(volume.index ?? { state: "paused", progress: 0 }),
                state: "paused",
                pauseReason: "user",
                message: "Индексация на паузе. Продолжение с места остановки.",
              };
            } else if (action === "resume" || action === "resume-all") {
              if (volume.index?.state === "paused") void indexVolume(volume, false, true, false);
            } else if (action === "cancel" || action === "cancel-all") {
              volume.signal = volume.signal ?? { pause: false, cancel: false, reason: null };
              volume.signal.cancel = true;
              volume.signal.pause = true;
              volume.signal.reason = "user";
              if (volume.index) {
                volume.index = { ...volume.index, state: "error", cancelled: true, pauseReason: null, message: "Отменено. Файлы пользователя не удалялись.", files: volume.index.files };
              }
            } else {
              send(response, 400, { error: "Неизвестное действие индексации." });
              return;
            }
          }
          persist();
          send(response, 202, { accepted: true });
        } catch {
          send(response, 400, { error: "Команда индексации не принята." });
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
            recordCount: volume.index.files?.length ?? volume.index.recordCount ?? volume.index.checkpoint?.recordsDone ?? 0,
            pauseReason: volume.index.pauseReason ?? null,
            currentFile: volume.index.currentFile ?? null,
            processedBytes: volume.index.processedBytes ?? 0,
            totalBytes: volume.index.totalBytes ?? volume.totalBytes,
            speed: volume.index.speed ?? 0,
            eta: volume.index.eta ?? null,
            priority: volume.priority ?? 0,
            checkpoint: volume.index.checkpoint ?? null,
            cancelled: volume.index.cancelled === true,
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
  void options.intervalMs;
  void tick();
  options.watch?.start((event) => { void applyWatch(event); });
  server.once("close", () => options.watch?.stop());
  return server;
}
