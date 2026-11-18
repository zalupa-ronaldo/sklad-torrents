import { AppError } from "@/lib/app-error";
import { cacheFromText, type CompactDbCache } from "@/lib/compact-db/database";
import { entriesFromNodes, applyUsn, entriesFromWalk, nodesFromMftFixture } from "@/lib/windows-library/index-model";
import { buildGames } from "@/lib/windows-library/inventory";
import { coverFor } from "@/lib/windows-library/covers";
import { chooseCompactAlgorithm } from "@/lib/windows-library/compression";
import { MemoryFs } from "@/lib/windows-library/memory-fs";
import { advanceJob, enqueueMove } from "@/lib/windows-library/pool";
import { emptyLibraryState, loadLibraryState, saveLibraryState } from "@/lib/windows-library/store";
import type {
  CatalogFile,
  IndexedEntry,
  LibraryEvent,
  LibraryState,
  LibraryView,
  PublicLibraryJob,
  PublicVolume,
  PublicWindowsGame,
  VolumeCursor,
  VolumeIdentity,
} from "@/lib/windows-library/types";
import { decideVolumeEvent, filesystemKind, libraryOs, noteDiskutil, noteMft, noteUsn, noteWalk, volumeKey } from "@/lib/windows-library/volume-policy";
import { splitUsnRead } from "@/lib/windows-library/usn-journal";
import { dataDir } from "@/lib/qbittorrent/store";

export async function readWindowsLibrary(directory = dataDir()): Promise<LibraryView> {
  return view(await loadLibraryState(directory));
}

export async function handleLibraryCommand(body: unknown, directory = dataDir()): Promise<unknown> {
  const state = await loadLibraryState(directory);
  const result = applyLibraryCommand(state, body);
  await saveLibraryState(directory, state);
  return result;
}

/** Pure command application. The HTTP handler saves the state and does not run a job. */
export function applyLibraryCommand(state: LibraryState, body: unknown): unknown {
  const record = recordOf(body);
  const action = typeof record.action === "string" ? record.action : "";
  if (action === "advance") throw new AppError(400, "Перенос и сжатие не выполняются внутри запроса.");
  if (action === "event") {
    const event = eventFrom(record.event);
    const identity = identityOf(event);
    const current = identity ? findCursor(state, identity) : null;
    const decision = decideVolumeEvent(current, event);
    replaceCursor(state, current, decision.cursor);
    return { actions: decision.actions, library: view(state) };
  }
  if (action === "mft") return acceptMft(state, record);
  if (action === "usn") return acceptUsn(state, record);
  if (action === "walk") return acceptWalk(state, record);
  if (action === "diskutil-cached") return acceptDiskutil(state, record);
  if (action === "settings") return acceptSettings(state, record);
  if (action === "remember-cover") return acceptCover(state, record);
  if (action === "compress") return acceptCompress(state, record);
  if (action === "play" || action === "return") return acceptMove(state, record, action);
  throw new AppError(400, "Неизвестное действие.");
}

/** Worker entry. Tests pass a MemoryFs. There is no disk implementation here. */
export function advanceWindowsLibrary(
  state: LibraryState,
  jobId: string,
  fs: MemoryFs,
  cache: CompactDbCache | null = null,
  options?: { mutateCopy?: (relative: string, bytes: Buffer) => Buffer },
) {
  const job = advanceJob(state, jobId, fs, cache, options);
  return { job: publicJob(job), library: view(state) };
}

function acceptMft(state: LibraryState, record: Record<string, unknown>) {
  const cursor = requireCursor(state, record);
  if (!cursor.mftTicket) throw new AppError(400, "Снимок MFT не запрошен. Повторное чтение таблицы не выполняется.");
  const nodes = nodesFrom(record);
  const key = volumeKey(cursor);
  const index = ensureIndex(state, key);
  index.nodes = nodes;
  index.flat = null;
  index.unplaced = 0;
  rememberTexts(state, key, record.texts);
  replaceCursor(state, cursor, noteMft(cursor));
  rebuild(state);
  return { ok: true, library: view(state) };
}

function acceptUsn(state: LibraryState, record: Record<string, unknown>) {
  const cursor = requireCursor(state, record);
  if (!cursor.usnTicket) throw new AppError(400, "Чтение USN не запрошено. Таблица MFT заново не читается.");
  const bytes = bytesFrom(record.journalBase64, "Нет буфера FSCTL_READ_USN_JOURNAL.");
  const split = splitUsnRead(bytes);
  const key = volumeKey(cursor);
  const index = ensureIndex(state, key);
  const applied = applyUsn(index.nodes, split.records);
  index.nodes = applied.nodes;
  index.flat = null;
  index.unplaced = applied.unplaced;
  rememberTexts(state, key, record.texts);
  replaceCursor(state, cursor, noteUsn(cursor, split.nextUsn.toString()));
  rebuild(state);
  return { ok: true, unplaced: applied.unplaced, library: view(state) };
}

function acceptWalk(state: LibraryState, record: Record<string, unknown>) {
  const cursor = requireCursor(state, record);
  if (!cursor.walkTicket) throw new AppError(400, "Обход не запрошен. Повторный обход не принимается.");
  const entries = entriesFrom(record.entries);
  const key = volumeKey(cursor);
  const index = ensureIndex(state, key);
  index.flat = entriesFromWalk(entries);
  index.nodes = [];
  index.unplaced = 0;
  rememberTexts(state, key, record.texts);
  replaceCursor(state, cursor, noteWalk(cursor));
  rebuild(state);
  return { ok: true, library: view(state) };
}

function acceptDiskutil(state: LibraryState, record: Record<string, unknown>) {
  const cursor = requireCursor(state, record);
  replaceCursor(state, cursor, noteDiskutil(cursor));
  return { ok: true, ran: false, library: view(state) };
}

function acceptSettings(state: LibraryState, record: Record<string, unknown>) {
  const fast = record.fastSsd;
  if (fast == null) {
    state.settings.fastSsd = null;
    return { ok: true, library: view(state) };
  }
  const body = recordOf(fast);
  const serial = text(body.serial);
  const uuid = text(body.uuid);
  const root = text(body.root);
  if (!serial || !uuid || !root) throw new AppError(400, "Для SSD нужны serial, uuid и root. Путь сам не выбирается.");
  state.settings.fastSsd = { serial, uuid, root };
  return { ok: true, library: view(state) };
}

function acceptCover(state: LibraryState, record: Record<string, unknown>) {
  const cacheKey = text(record.cacheKey);
  if (!cacheKey) throw new AppError(400, "Нет ключа кэша обложки.");
  state.covers[cacheKey] = {
    source: record.source === "steamgriddb" || record.source === "steam-app" || record.source === "name" || record.source === "cache" ? record.source : "name",
    url: typeof record.url === "string" ? record.url : null,
    cachedAt: new Date().toISOString(),
  };
  for (const game of state.games) game.cover = coverFor(game, state.covers);
  return { ok: true, fetched: false, library: view(state) };
}

function acceptCompress(state: LibraryState, record: Record<string, unknown>) {
  const game = requireGame(state, text(record.id));
  const choice = chooseCompactAlgorithm({
    steamAppId: game.steamAppId,
    cache: databaseFrom(record.database),
    already: game.algorithm,
  });
  if (!choice.enqueue) return { ok: true, created: false, reason: choice.reason, library: view(state) };
  const existing = state.jobs.find((job) => job.gameId === game.id && job.kind === "compress" && job.state === "queued");
  if (existing) return { ok: true, created: false, job: publicJob(existing), library: view(state) };
  const job = {
    id: `wjob-compress-${game.id.slice(3, 11)}`,
    kind: "compress" as const,
    gameId: game.id,
    state: "queued" as const,
    phase: "queued",
    percent: 0,
    confirm: false,
    error: null,
    sourceDeleted: false,
    verified: false,
    compactAlgorithm: choice.algorithm,
    phases: [] as string[],
    sourceRoot: game.root,
    destRoot: game.root,
    destLibrary: null,
    manifestPath: null,
    libraryFoldersPath: null,
    installdir: null,
    steamAppId: game.steamAppId,
    launcher: game.launcher,
  };
  state.jobs.push(job);
  game.compression = "queued";
  game.algorithm = choice.algorithm;
  return { ok: true, created: true, job: publicJob(job), reason: choice.reason, library: view(state) };
}

function acceptMove(state: LibraryState, record: Record<string, unknown>, kind: "play" | "return") {
  const game = requireGame(state, text(record.id));
  const processes = processesFrom(record.processes);
  const job = enqueueMove(state, { game, kind, confirm: record.confirm === true, processes });
  return { ok: true, created: true, job: publicJob(job), library: view(state) };
}

function rebuild(state: LibraryState): void {
  const previous = state.games;
  const slices = state.volumes.map((cursor) => {
    const key = volumeKey(cursor);
    const index = state.indexes.find((item) => item.key === key);
    const entries = index?.flat ?? entriesFromNodes(index?.nodes ?? [], mountOf(cursor));
    const texts = state.catalog.filter((item) => item.volumeKey === key);
    return { cursor, entries, texts };
  });
  const built = buildGames(slices, state.covers);
  state.games = built.map((game) => {
    const old = previous.find((item) => item.id === game.id);
    if (!old) return game;
    if (old.pool !== "playing") return { ...game, archiveRoot: old.archiveRoot, archiveSerial: old.archiveSerial, archiveUuid: old.archiveUuid };
    return {
      ...game,
      pool: "playing",
      root: old.root,
      serial: old.serial,
      uuid: old.uuid,
      archiveRoot: old.archiveRoot,
      archiveSerial: old.archiveSerial,
      archiveUuid: old.archiveUuid,
      manifestPath: old.manifestPath,
      compression: old.compression === "queued" ? old.compression : game.compression,
      algorithm: old.compression === "queued" ? old.algorithm : game.algorithm,
    };
  });
  for (const game of state.games) game.online = state.volumes.some((volume) => volume.serial === game.serial && volume.uuid === game.uuid && volume.attached);
}

function rememberTexts(state: LibraryState, key: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const body = recordOf(item);
    const relativePath = text(body.relativePath);
    const fileText = typeof body.text === "string" ? body.text : "";
    if (!relativePath || !fileText) continue;
    const next: CatalogFile = { volumeKey: key, relativePath: relativePath.replace(/\\/g, "/"), text: fileText };
    state.catalog = state.catalog.filter((entry) => !(entry.volumeKey === key && entry.relativePath.toLowerCase() === next.relativePath.toLowerCase()));
    state.catalog.push(next);
  }
}

function nodesFrom(record: Record<string, unknown>) {
  if (typeof record.fixtureBase64 === "string") return nodesFromMftFixture(Buffer.from(record.fixtureBase64, "base64"));
  if (!Array.isArray(record.nodes)) throw new AppError(400, "Нужен снимок MFT: fixtureBase64 или nodes. Диск отсюда не читается.");
  return record.nodes.map((item) => {
    const body = recordOf(item);
    const fileRef = text(body.fileRef);
    const parentRef = text(body.parentRef);
    const name = text(body.name);
    if (!fileRef || !parentRef || !name) throw new AppError(400, "У записи MFT нет fileRef, parentRef или имени.");
    return {
      fileRef,
      parentRef,
      name,
      isDirectory: body.isDirectory === true,
      logicalBytes: numberOrNull(body.logicalBytes),
      allocatedBytes: numberOrNull(body.allocatedBytes),
      compressed: body.compressed === true ? true : body.compressed === false ? false : null,
      algorithm: text(body.algorithm),
    };
  });
}

function entriesFrom(value: unknown): IndexedEntry[] {
  if (!Array.isArray(value)) throw new AppError(400, "Нужен список записей индекса. Обход отсюда не запускается.");
  return value.map((item) => {
    const body = recordOf(item);
    const relativePath = text(body.relativePath);
    if (!relativePath) throw new AppError(400, "У записи индекса нет пути.");
    return {
      relativePath,
      name: text(body.name) || relativePath.split("/").pop() || relativePath,
      isDirectory: body.isDirectory === true,
      logicalBytes: numberOrNull(body.logicalBytes),
      allocatedBytes: numberOrNull(body.allocatedBytes),
      compressed: body.compressed === true ? true : body.compressed === false ? false : null,
      algorithm: text(body.algorithm),
    };
  });
}

function view(state: LibraryState): LibraryView {
  const games: PublicWindowsGame[] = state.games.map((game) => ({
    id: game.id,
    title: game.title,
    launcher: game.launcher,
    steamAppId: game.steamAppId,
    root: game.root,
    serial: game.serial,
    uuid: game.uuid,
    logicalBytes: game.logicalBytes,
    allocatedBytes: game.allocatedBytes,
    compression: game.compression,
    algorithm: game.algorithm,
    cover: game.cover,
    pool: game.pool,
    online: game.online,
    job: latestJob(state, game.id),
  }));
  const volumes: PublicVolume[] = state.volumes.map((volume) => {
    const index = state.indexes.find((item) => item.key === volumeKey(volume));
    return {
      serial: volume.serial,
      uuid: volume.uuid,
      os: volume.os,
      filesystem: volume.filesystem,
      letter: volume.letter,
      attached: volume.attached,
      mftIndexed: volume.mftIndexed,
      walked: volume.walked,
      journalId: volume.journalId,
      nextUsn: volume.nextUsn,
      lastEventId: volume.lastEventId,
      diskutilCached: volume.diskutilCached,
      index: index?.flat ? "walk" : volume.journalId && volume.mftIndexed ? "usn" : volume.mftIndexed ? "mft" : volume.walked ? "walk" : "none",
      unplaced: index?.unplaced ?? 0,
    };
  });
  return { games, volumes, settings: state.settings, polling: false };
}

function latestJob(state: LibraryState, gameId: string): PublicLibraryJob | null {
  const jobs = state.jobs.filter((job) => job.gameId === gameId);
  const job = jobs[jobs.length - 1];
  return job ? publicJob(job) : null;
}

function publicJob(job: LibraryState["jobs"][number]): PublicLibraryJob {
  return {
    id: job.id,
    kind: job.kind,
    gameId: job.gameId,
    state: job.state,
    phase: job.phase,
    percent: job.percent,
    error: job.error,
    sourceDeleted: job.sourceDeleted,
    verified: job.verified,
    compactAlgorithm: job.compactAlgorithm,
  };
}

function requireCursor(state: LibraryState, record: Record<string, unknown>): VolumeCursor {
  const serial = text(record.serial);
  const uuid = text(record.uuid);
  if (!serial || !uuid) throw new AppError(400, "Нужны serial и uuid тома.");
  const cursor = state.volumes.find((volume) => volume.serial === serial && volume.uuid.toLowerCase() === uuid.toLowerCase());
  if (!cursor) throw new AppError(404, "Том не подключён событием.");
  return cursor;
}

function requireGame(state: LibraryState, id: string | null) {
  const game = state.games.find((item) => item.id === id);
  if (!game) throw new AppError(404, "Игры в библиотеке нет.");
  return game;
}

function findCursor(state: LibraryState, identity: VolumeIdentity): VolumeCursor | null {
  return state.volumes.find((volume) => volumeKey(volume) === volumeKey(identity)) ?? null;
}

function replaceCursor(state: LibraryState, previous: VolumeCursor | null, next: VolumeCursor | null): void {
  if (previous) state.volumes = state.volumes.filter((volume) => volume !== previous);
  if (next) state.volumes.push(next);
}

function ensureIndex(state: LibraryState, key: string) {
  const found = state.indexes.find((item) => item.key === key);
  if (found) return found;
  const created = { key, nodes: [], flat: null, unplaced: 0 };
  state.indexes.push(created);
  return created;
}

function identityOf(event: LibraryEvent): VolumeIdentity | null {
  if (event.type === "poll") return null;
  return event.identity;
}

function eventFrom(value: unknown): LibraryEvent {
  const body = recordOf(value);
  const type = text(body.type);
  if (type === "poll") return { type: "poll" };
  if (type === "wmi") return { type: "wmi", eventType: Number(body.eventType), identity: identityFrom(body.identity) };
  if (type === "dbt") return { type: "dbt", code: Number(body.code), identity: identityFrom(body.identity) };
  if (type === "mac-appear" || type === "mac-disappear") return { type, identity: identityFrom(body.identity) };
  if (type === "fsevent") {
    return {
      type: "fsevent",
      identity: identityFrom(body.identity),
      eventId: text(body.eventId) ?? "",
      historyDropped: body.historyDropped === true,
    };
  }
  if (type === "journal-info") {
    return {
      type: "journal-info",
      identity: identityFrom(body.identity),
      journalId: text(body.journalId) ?? "",
      lowestValidUsn: text(body.lowestValidUsn) ?? "",
      nextUsn: text(body.nextUsn) ?? "",
    };
  }
  throw new AppError(400, "Неизвестное событие тома.");
}

function identityFrom(value: unknown): VolumeIdentity {
  const body = recordOf(value);
  const os = libraryOs(text(body.os) ?? "");
  const serial = text(body.serial);
  const uuid = text(body.uuid);
  if (!os || !serial || !uuid) throw new AppError(400, "У тома нужны os, serial и uuid.");
  return {
    serial,
    uuid,
    os,
    filesystem: filesystemKind(text(body.filesystem) ?? ""),
    letter: text(body.letter)?.replace(":", "").toUpperCase() ?? null,
    mount: text(body.mount),
  };
}

function processesFrom(value: unknown): { path: string }[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => ({ path: text(recordOf(item).path) ?? "" }));
}

function databaseFrom(value: unknown): CompactDbCache | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return cacheFromText(value, new Date().toISOString());
}

function bytesFrom(value: unknown, message: string): Buffer {
  if (typeof value !== "string" || !value) throw new AppError(400, message);
  return Buffer.from(value, "base64");
}

function mountOf(cursor: VolumeCursor): string {
  if (cursor.mount) return cursor.mount;
  if (cursor.letter) return `${cursor.letter}:\\`;
  return "\\";
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export { emptyLibraryState };
