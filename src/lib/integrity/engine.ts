import { createHash, randomUUID } from "node:crypto";

import { ACTIVE_JOB, type BackgroundJob } from "@/lib/jobs/types";
import { mutateJobs, patchJob } from "@/lib/jobs/store";
import { applyComparison, deletionDecision, filesDone, isHashed } from "@/lib/integrity/compare";
import type { ByteReader } from "@/lib/integrity/hash";
import { manifestDocument, manifestFilename } from "@/lib/integrity/manifest";
import { mutateIntegrity, readIntegrity } from "@/lib/integrity/store";
import type { HashFileRecord, HashSide, IntegrityJob, IntegrityKind } from "@/lib/integrity/types";

export const INTEGRITY_JOB_KIND = "sha256";

const CHUNK = 64 * 1024;

interface Readers {
  source: ByteReader;
  destination: ByteReader | null;
}

interface EnqueueInput {
  kind: IntegrityKind;
  title: string;
  comparable?: boolean;
  source: ByteReader;
  destination?: ByteReader | null;
  transferDone?: boolean;
  rewritable?: boolean;
  sourceLabel?: string;
  destinationLabel?: string;
  torrent?: { hostId: string; hash: string; name: string };
  idempotencyKey?: string;
}

class IntegrityHalt extends Error {
  constructor() {
    super("halt");
    this.name = "IntegrityHalt";
  }
}

let gate: Promise<void> | null = null;
const readersById = new Map<string, Readers>();
const running = new Set<string>();
const aborts = new Map<string, AbortController>();

export function setIntegrityGateForTests(next: Promise<void> | null): void {
  gate = next;
}

export function clearIntegrityRuntimeForTests(): void {
  gate = null;
  readersById.clear();
  running.clear();
  for (const controller of aborts.values()) controller.abort();
  aborts.clear();
}

export async function enqueueIntegrity(input: EnqueueInput): Promise<IntegrityJob> {
  const comparable = input.comparable ?? defaultComparable(input.kind);
  const key = input.idempotencyKey ?? integrityKey(input);
  const now = new Date().toISOString();
  const job = blankJob({
    id: `hash-${randomUUID()}`,
    kind: input.kind,
    title: input.title,
    comparable,
    transferDone: input.kind === "localsend" ? input.transferDone === true : true,
    rewritable: input.rewritable === true,
    sourceLabel: input.sourceLabel ?? "",
    destinationLabel: input.destinationLabel ?? "",
    torrentHostId: input.torrent?.hostId ?? "",
    torrentHash: input.torrent?.hash ?? "",
    torrentName: input.torrent?.name ?? "",
    now,
  });
  const stored = await mutateIntegrity((file) => {
    const existing = file.jobs.find((item) => item.id === key || (item.torrentHostId === job.torrentHostId && item.torrentHash === job.torrentHash && item.torrentHash && item.state !== "done" && item.state !== "error" && item.state !== "cancelled"));
    if (input.torrent && existing) return existing;
    file.jobs.push(job);
    return job;
  });
  if (stored.id !== job.id) {
    readersById.set(stored.id, { source: input.source, destination: input.destination ?? null });
    return stored;
  }
  readersById.set(job.id, { source: input.source, destination: input.destination ?? null });
  await publishBackground(job, key);
  setTimeout(() => {
    void runJob(job.id);
  }, 0);
  return job;
}

export async function getIntegrityJob(id: string): Promise<IntegrityJob | null> {
  const file = await readIntegrity();
  return file.jobs.find((job) => job.id === id) ?? null;
}

export async function listIntegrityJobs(): Promise<IntegrityJob[]> {
  const file = await readIntegrity();
  return [...file.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function cancelIntegrity(id: string): Promise<IntegrityJob> {
  aborts.get(id)?.abort();
  const job = await mutateIntegrity((file) => {
    const current = file.jobs.find((item) => item.id === id);
    if (!current) return null;
    if (current.state === "done") return current;
    current.state = "cancelled";
    current.error = null;
    current.deleteAllowed = false;
    current.deleteReason = "Отменено. Уже посчитанные хэши сохранены, файлы не удалялись.";
    touch(current);
    return current;
  });
  if (!job) throw new Error("Задача хэша не найдена.");
  await mirror(job);
  return job;
}

export async function confirmIntegrityDelete(id: string, confirmed: boolean): Promise<IntegrityJob> {
  const job = await mutateIntegrity((file) => {
    const current = file.jobs.find((item) => item.id === id);
    if (!current) return null;
    current.userConfirmed = confirmed === true;
    const decision = deletionDecision(current);
    current.deleteAllowed = decision.deleteAllowed;
    current.deleteReason = decision.reason;
    touch(current);
    return current;
  });
  if (!job) throw new Error("Задача хэша не найдена.");
  return job;
}

export async function markTransferDone(id: string): Promise<IntegrityJob> {
  const job = await mutateIntegrity((file) => {
    const current = file.jobs.find((item) => item.id === id);
    if (!current) return null;
    current.transferDone = true;
    current.state = "queued";
    current.error = null;
    touch(current);
    return current;
  });
  if (!job) throw new Error("Задача хэша не найдена.");
  setTimeout(() => {
    void runJob(id);
  }, 0);
  return job;
}

/** Continue a stored job. Already hashed files are not read again. */
export async function continueIntegrity(
  id: string,
  attached: { source: ByteReader; destination?: ByteReader | null },
): Promise<IntegrityJob> {
  readersById.set(id, { source: attached.source, destination: attached.destination ?? null });
  return runJob(id);
}

export async function torrentManifest(hostId: string, hash: string): Promise<{
  ready: boolean;
  filename: string;
  text: string;
  files: HashFileRecord[];
  job: IntegrityJob | null;
}> {
  const file = await readIntegrity();
  const record = file.torrents.find((item) => item.hostId === hostId && item.hash === hash) ?? null;
  const job = [...file.jobs].reverse().find((item) => item.torrentHostId === hostId && item.torrentHash === hash) ?? null;
  const files = (record?.files ?? job?.files ?? []).filter((item) => item.side === "source");
  const ready = files.length > 0 && files.every((item) => item.sha256.length === 64);
  const name = record?.name || job?.torrentName || "torrent";
  return {
    ready,
    filename: manifestFilename(name),
    text: ready ? manifestDocument(files.map((item) => ({ sha256: item.sha256, relativePath: item.relativePath }))) : "",
    files,
    job,
  };
}

export function presentIntegrityJob(job: BackgroundJob) {
  const cancelled = job.payload.cancelled === true || job.phase.startsWith("Отменено");
  const state = cancelled ? "cancelled" : job.status;
  return {
    id: job.id,
    kind: job.kind,
    state,
    progress: job.percent,
    title: job.title,
    message: job.phase,
    error: job.error,
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
    currentFile: job.currentFile,
    bytesDone: job.bytesDone,
    bytesTotal: job.bytesTotal,
    filesDone: typeof job.payload.filesDone === "number" ? job.payload.filesDone : null,
    filesTotal: typeof job.payload.filesTotal === "number" ? job.payload.filesTotal : null,
    speed: typeof job.payload.speed === "number" ? job.payload.speed : 0,
    etaSeconds: typeof job.payload.etaSeconds === "number" ? job.payload.etaSeconds : null,
  };
}

async function runJob(id: string): Promise<IntegrityJob> {
  if (running.has(id)) {
    const current = await getIntegrityJob(id);
    if (current) return current;
  }
  running.add(id);
  const controller = new AbortController();
  aborts.set(id, controller);
  const started = Date.now();
  try {
    if (gate) await gate;
    let job = await getIntegrityJob(id);
    if (!job) throw new Error("Задача хэша не найдена.");
    if (job.state === "cancelled" || job.state === "paused") return job;
    const readers = readersById.get(id);
    if (!readers) {
      job = await fail(id, "Нет читателя файлов. Диск из этого процесса не открывался.");
      return job;
    }
    job = await update(id, (current) => {
      if (current.state === "cancelled") return;
      current.state = "running";
    });
    if (job.state === "cancelled") return job;
    await ensureFileList(job, readers, controller.signal);
    job = (await getIntegrityJob(id)) ?? job;
    if (job.state === "cancelled") return job;
    await hashPending(id, readers, controller.signal, started);
    job = (await getIntegrityJob(id)) ?? job;
    if (job.state === "cancelled" || job.state === "paused") return job;
    job = await finish(id);
    return job;
  } catch (error) {
    if (error instanceof IntegrityHalt || controller.signal.aborted) {
      const current = await getIntegrityJob(id);
      if (current) return current;
    }
    const message = error instanceof Error ? error.message : "Не удалось посчитать SHA-256.";
    return fail(id, message);
  } finally {
    running.delete(id);
    aborts.delete(id);
  }
}

async function ensureFileList(job: IntegrityJob, readers: Readers, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new IntegrityHalt();
  if (job.files.length > 0) return;
  const source = await readers.source.list();
  const destination = readers.destination && needsDestination(job) ? await readers.destination.list() : [];
  const now = new Date().toISOString();
  const files: HashFileRecord[] = [
    ...source.map((file) => pendingRecord(file.relativePath, file.size, "source", now)),
    ...destination.map((file) => pendingRecord(file.relativePath, file.size, "destination", now)),
  ];
  await update(job.id, (current) => {
    if (current.files.length === 0) current.files = files;
    refreshProgress(current, Date.now());
  });
}

async function hashPending(id: string, readers: Readers, signal: AbortSignal, started: number): Promise<void> {
  const snapshot = await getIntegrityJob(id);
  if (!snapshot) return;
  const order = snapshot.files.map((file, index) => ({ file, index })).filter(({ file }) => !isHashed(file));
  for (const { index } of order) {
    if (signal.aborted) throw new IntegrityHalt();
    const current = await getIntegrityJob(id);
    if (!current || current.state === "cancelled" || current.state === "paused") throw new IntegrityHalt();
    const file = current.files[index];
    if (!file || isHashed(file)) continue;
    if (current.kind === "localsend" && !current.transferDone && file.side === "destination") continue;
    const reader = file.side === "destination" ? readers.destination : readers.source;
    if (!reader) {
      await update(id, (job) => {
        const target = job.files[index];
        if (!target) return;
        target.status = "error";
        target.updatedAt = new Date().toISOString();
        job.error = `Нет файла на второй стороне: ${target.relativePath}`;
      });
      continue;
    }
    try {
      await digestFile(id, index, reader, signal, started);
    } catch (error) {
      if (error instanceof IntegrityHalt || signal.aborted) throw new IntegrityHalt();
      const message = error instanceof Error ? error.message : "Ошибка чтения.";
      await update(id, (job) => {
        const target = job.files[index];
        if (!target) return;
        target.status = "error";
        target.updatedAt = new Date().toISOString();
        job.error = message;
        refreshProgress(job, started);
      });
    }
  }
}

async function digestFile(
  id: string,
  index: number,
  reader: ByteReader,
  signal: AbortSignal,
  started: number,
): Promise<void> {
  const initial = await getIntegrityJob(id);
  const file = initial?.files[index];
  if (!file || isHashed(file)) return;
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < file.size) {
    if (signal.aborted) throw new IntegrityHalt();
    const length = Math.min(CHUNK, file.size - offset);
    const chunk = await reader.read(file.relativePath, offset, length);
    if (chunk.byteLength === 0) break;
    hash.update(chunk);
    offset += chunk.byteLength;
    await update(id, (job) => {
      if (job.state === "cancelled") return;
      const target = job.files[index];
      if (!target || isHashed(target)) return;
      target.status = "hashing";
      target.bytesHashed = offset;
      target.updatedAt = new Date().toISOString();
      job.checkpoint = { relativePath: target.relativePath, byteOffset: offset };
      job.currentFile = target.relativePath;
      refreshProgress(job, started);
    });
  }
  if (offset !== file.size && file.size > 0) {
    throw new Error(`Прочитано ${offset} из ${file.size} байт: ${file.relativePath}`);
  }
  const digest = hash.digest("hex");
  await update(id, (job) => {
    const target = job.files[index];
    if (!target) return;
    target.sha256 = digest;
    target.bytesHashed = target.size;
    target.status = job.comparable ? "hashing" : "recorded";
    target.updatedAt = new Date().toISOString();
    job.checkpoint = { relativePath: target.relativePath, byteOffset: target.size };
    refreshProgress(job, started);
  });
}

async function finish(id: string): Promise<IntegrityJob> {
  return update(id, (job) => {
    if (job.state === "cancelled" || job.state === "paused") return;
    applyComparison(job);
    const decision = deletionDecision(job);
    job.deleteAllowed = decision.deleteAllowed;
    job.deleteReason = decision.reason;
    job.filesDone = filesDone(job.files);
    job.filesTotal = job.files.length;
    job.percent = 100;
    job.bytesHashed = job.bytesTotal;
    job.speed = 0;
    job.etaSeconds = 0;
    job.checkpoint = null;
    if (job.kind === "compact" && job.mismatchPaths.length > 0) job.state = "error";
    else if (job.kind === "optical" && (job.mismatchPaths.length > 0 || job.files.some((file) => file.status === "error"))) {
      job.state = "error";
      job.discVerified = false;
    } else if (job.files.some((file) => file.status === "error") && job.files.every((file) => file.status === "error" || !file.sha256)) {
      job.state = "error";
    } else job.state = "done";
    if (job.kind === "optical" && job.state === "done" && job.mismatchPaths.length === 0 && job.files.some((file) => file.status === "match")) {
      job.discVerified = true;
    }
    touch(job);
  }).then(async (job) => {
    await rememberCatalog(job);
    return job;
  });
}

async function rememberCatalog(job: IntegrityJob): Promise<void> {
  await mutateIntegrity((file) => {
    if (job.kind === "torrent" && job.torrentHash) {
      const files = job.files.filter((item) => item.side === "source" && item.sha256);
      const row = {
        hostId: job.torrentHostId,
        hash: job.torrentHash,
        name: job.torrentName || job.title,
        files,
        jobId: job.id,
        updatedAt: job.updatedAt,
      };
      const index = file.torrents.findIndex((item) => item.hostId === row.hostId && item.hash === row.hash);
      if (index >= 0) file.torrents[index] = row;
      else if (files.length) file.torrents.push(row);
    }
    if (job.kind === "optical" && job.discVerified) {
      const checksums = job.files
        .filter((item) => item.side === "source" && item.status === "match")
        .map((item) => ({ relativePath: item.relativePath, size: item.size, sha256: item.sha256 }));
      if (!file.discs.some((item) => item.jobId === job.id)) {
        file.discs.push({
          id: `disc-${job.id}`,
          jobId: job.id,
          verified: true,
          rewritable: job.rewritable,
          erased: false,
          checksums,
          updatedAt: job.updatedAt,
        });
      }
    }
  });
}

async function fail(id: string, message: string): Promise<IntegrityJob> {
  const job = await update(id, (current) => {
    if (current.state === "cancelled") return;
    current.state = "error";
    current.error = message;
    current.deleteAllowed = false;
    current.deleteReason = "Хэш не посчитан. Удаление исходных файлов выключено.";
    touch(current);
  });
  return job;
}

async function update(id: string, fn: (job: IntegrityJob) => void): Promise<IntegrityJob> {
  const job = await mutateIntegrity((file) => {
    const current = file.jobs.find((item) => item.id === id);
    if (!current) return null;
    fn(current);
    touch(current);
    refreshProgress(current, Date.parse(current.createdAt) || Date.now());
    return current;
  });
  if (!job) throw new Error("Задача хэша не найдена.");
  await mirror(job);
  return job;
}

function refreshProgress(job: IntegrityJob, started: number): void {
  job.filesTotal = job.files.length;
  job.filesDone = filesDone(job.files);
  job.bytesTotal = job.files.reduce((sum, file) => sum + file.size, 0);
  job.bytesHashed = job.files.reduce((sum, file) => sum + Math.min(file.size, file.bytesHashed), 0);
  job.percent = job.bytesTotal === 0 ? (job.filesTotal === 0 ? 0 : (job.filesDone / job.filesTotal) * 100) : (job.bytesHashed / job.bytesTotal) * 100;
  const elapsed = Math.max(0.05, (Date.now() - started) / 1000);
  job.speed = job.bytesHashed > 0 ? job.bytesHashed / elapsed : 0;
  const left = Math.max(0, job.bytesTotal - job.bytesHashed);
  job.etaSeconds = job.speed > 0 ? left / job.speed : null;
  const hashing = job.files.find((file) => file.status === "hashing");
  if (hashing) job.currentFile = hashing.relativePath;
}

function blankJob(input: {
  id: string;
  kind: IntegrityKind;
  title: string;
  comparable: boolean;
  transferDone: boolean;
  rewritable: boolean;
  sourceLabel: string;
  destinationLabel: string;
  torrentHostId: string;
  torrentHash: string;
  torrentName: string;
  now: string;
}): IntegrityJob {
  return {
    id: input.id,
    kind: input.kind,
    state: "queued",
    title: input.title,
    comparable: input.comparable,
    files: [],
    checkpoint: null,
    currentFile: "",
    filesDone: 0,
    filesTotal: 0,
    bytesHashed: 0,
    bytesTotal: 0,
    percent: 0,
    speed: 0,
    etaSeconds: null,
    transferDone: input.transferDone,
    userConfirmed: false,
    deleteAllowed: false,
    deleteReason: "Сверка SHA-256 ещё не закончена.",
    mismatchPaths: [],
    error: null,
    discVerified: false,
    sourceLabel: input.sourceLabel,
    destinationLabel: input.destinationLabel,
    torrentHostId: input.torrentHostId,
    torrentHash: input.torrentHash,
    torrentName: input.torrentName,
    rewritable: input.rewritable,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function pendingRecord(relativePath: string, size: number, side: HashSide, now: string): HashFileRecord {
  return { relativePath, size, sha256: "", status: "pending", bytesHashed: 0, updatedAt: now, side };
}

function touch(job: IntegrityJob): void {
  job.updatedAt = new Date().toISOString();
}

function defaultComparable(kind: IntegrityKind): boolean {
  return kind !== "handbrake" && kind !== "torrent";
}

function needsDestination(job: IntegrityJob): boolean {
  if (!job.comparable) return job.kind === "handbrake";
  if (job.kind === "localsend" && !job.transferDone) return false;
  return true;
}

function integrityKey(input: EnqueueInput): string {
  if (input.torrent) return ["sha256", "torrent", input.torrent.hostId, input.torrent.hash].join("\0");
  return ["sha256", input.kind, input.title, randomUUID()].join("\0");
}

async function publishBackground(job: IntegrityJob, key: string): Promise<void> {
  const background: BackgroundJob = {
    id: job.id,
    kind: INTEGRITY_JOB_KIND,
    status: "queued",
    phase: "В очереди. SHA-256 считается в фоне и не блокирует окно.",
    percent: 0,
    currentFile: null,
    bytesDone: 0,
    bytesTotal: 0,
    title: job.title,
    error: null,
    mock: true,
    hardware: false,
    idempotencyKey: key,
    claimedBy: null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    payload: payloadOf(job),
  };
  await mutateJobs((jobs) => {
    const existing = jobs.find((item) => item.id === job.id || (item.idempotencyKey === key && ACTIVE_JOB.has(item.status)));
    if (existing) return existing;
    jobs.push(background);
    return background;
  });
}

async function mirror(job: IntegrityJob): Promise<void> {
  const status = job.state === "cancelled" ? "paused" : job.state === "running" ? "running" : job.state === "queued" ? "queued" : job.state === "done" ? "done" : "error";
  await patchJob(job.id, {
    status,
    phase: phaseOf(job),
    percent: Math.max(0, Math.min(100, job.percent)),
    currentFile: job.currentFile || null,
    bytesDone: job.bytesHashed,
    bytesTotal: job.bytesTotal,
    error: job.error,
    payload: payloadOf(job),
  });
}

function payloadOf(job: IntegrityJob): Record<string, unknown> {
  return {
    cancelled: job.state === "cancelled",
    filesDone: job.filesDone,
    filesTotal: job.filesTotal,
    speed: job.speed,
    etaSeconds: job.etaSeconds,
    comparable: job.comparable,
    mismatchPaths: job.mismatchPaths,
    deleteAllowed: job.deleteAllowed,
    message: phaseOf(job),
  };
}

function phaseOf(job: IntegrityJob): string {
  if (job.state === "cancelled") return "Отменено. Уже посчитанные хэши сохранены, файлы не удалялись.";
  if (job.state === "queued") return "В очереди. SHA-256 считается в фоне и не блокирует окно.";
  if (job.state === "error") return job.error || "Ошибка SHA-256. Файлы не удалялись.";
  if (job.state === "done" && job.mismatchPaths.length > 0) {
    return `Отличается: ${job.mismatchPaths.join(", ")}. Удаление исходных файлов выключено.`;
  }
  if (job.state === "done") return "SHA-256 записан. Файлы не удалялись.";
  const file = job.currentFile || "файл";
  return `${file} · ${job.filesDone}/${job.filesTotal}`;
}
