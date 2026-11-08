import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { createJobStore, type JobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";
import { decideSourceRetirement, type FileIdentity } from "@/lib/policies/source-retirement";
import { dataDir } from "@/lib/qbittorrent/store";
import { assignEncodeJobs, type EncodeCodec } from "@/lib/transcode/assign";
import {
  assertEncodePaths,
  capabilityFromHelp,
  CONSERVATIVE_PRESET,
  ENCODE_LIMITS,
  encodeArgv,
  mediaFromProbe,
  pathInside,
  requirementBlock,
  scratchFits,
  verifyMedia,
  type HandBrakeCapability,
  type MediaFacts,
} from "@/lib/transcode/encode-plan";

export interface EncodeProbe {
  ok: boolean;
  present: boolean;
  binary: string | null;
  version: string | null;
  encoders: string[];
  hardwareAv1: boolean;
  advertisedHardwareAv1: string[];
  videoToolbox: null;
  platform: NodeJS.Platform;
  pcVerified: false;
  macVerified: false;
  remote: { host: "pc-agent" | "mac-local"; state: "blocked"; reason: string }[];
  preset: { id: string; configured: true; label: string };
  compact: false;
}

const REMOTE_BLOCKED = [
  { host: "pc-agent" as const, state: "blocked" as const, reason: "Путь Windows и LAN не доступны с этой машины. Процесс Linux это не проверяет." },
  { host: "mac-local" as const, state: "blocked" as const, reason: "Путь Mac и LAN не доступны с этой машины. Процесс Linux это не проверяет." },
];

export async function probeEncoder(): Promise<EncodeProbe> {
  const binary = await findBinary(process.env.SKLAD_HANDBRAKE || "HandBrakeCLI");
  const base = {
    binary,
    platform: process.platform,
    pcVerified: false as const,
    macVerified: false as const,
    remote: REMOTE_BLOCKED,
    preset: { id: CONSERVATIVE_PRESET.id, configured: true as const, label: CONSERVATIVE_PRESET.label },
    compact: false as const,
    videoToolbox: null,
  };
  if (!binary) {
    return { ok: false, present: false, version: null, encoders: [], hardwareAv1: false, advertisedHardwareAv1: [], ...base };
  }
  const [help, versionText] = await Promise.all([
    collect(binary, ["--help"], 15_000),
    collect(binary, ["--version"], 15_000),
  ]);
  const capability = capabilityFromHelp(`${help.stdout}\n${help.stderr}`, `${versionText.stdout}\n${versionText.stderr}`);
  return {
    ok: capability.present,
    present: capability.present,
    version: capability.version,
    encoders: capability.encoders,
    hardwareAv1: false,
    advertisedHardwareAv1: capability.advertisedHardwareAv1,
    ...base,
  };
}

export async function enqueueEncode(input: {
  source: string;
  destination: string;
  codec: EncodeCodec;
  allowSoftware: boolean;
  torrentHash?: string;
  directory?: string;
}): Promise<Record<string, unknown>> {
  const directory = input.directory ?? dataDir();
  assertEncodePaths([input.source, input.destination]);
  const probe = await probeEncoder();
  if (!probe.present || !probe.binary) {
    return { ok: false, state: "blocked", started: false, error: "HandBrakeCLI не найден. Кодирование не поставлено." };
  }
  const info = await stat(input.source);
  if (!info.isFile()) return { ok: false, state: "blocked", started: false, error: "Источник должен быть обычным файлом." };
  if (info.size <= 0 || info.size > ENCODE_LIMITS.maxSourceBytes) {
    return { ok: false, state: "blocked", started: false, error: "Источник пустой или больше предела 32 МБ этого прогона." };
  }
  try {
    await stat(input.destination);
    return { ok: false, state: "blocked", started: false, error: "Файл назначения уже есть. Он не перезаписывается." };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = path.dirname(input.destination);
  try {
    const parentInfo = await stat(parent);
    if (!parentInfo.isDirectory()) return { ok: false, state: "blocked", started: false, error: "Каталога назначения нет." };
  } catch {
    return { ok: false, state: "blocked", started: false, error: "Каталога назначения нет. Путь не выдумывается." };
  }
  const space = await freeBytes(parent);
  const room = scratchFits(space, info.size);
  if (!room.ok) return { ok: false, state: "blocked", started: false, error: room.reason };
  const facts = await probeMedia(input.source);
  const capability = await readCapability(probe.binary);
  const blocked = requirementBlock(facts, capability, input.codec);
  if (blocked) return { ok: false, state: "blocked", started: false, error: blocked, codec: input.codec };
  const assignment = assignEncodeJobs(
    [{ id: "next", codec: input.codec, allowSoftware: input.allowSoftware }],
    [{
      id: "linux-local",
      os: "linux",
      slots: 1,
      probe: { hardwareAv1: capability.hardwareAv1, videoToolbox: null, amf: null, encoders: capability.encoders },
    }],
  );
  if (assignment[0]?.state !== "leased") {
    return { ok: false, state: "blocked", started: false, codec: input.codec, assignment: assignment[0], error: assignment[0]?.reason, pcVerified: false, macVerified: false };
  }
  const store = createJobStore(directory);
  const queued = await store.enqueue({
    kind: "transcode",
    host: "linux-local",
    source: input.source,
    destination: input.destination,
    handbrakeProfile: `c:${input.codec}:${input.allowSoftware ? "sw" : "hw"}`,
    ...(input.torrentHash ? { torrentHash: input.torrentHash } : {}),
  });
  return {
    ok: true,
    state: "queued",
    started: false,
    jobId: queued.job.id,
    created: queued.created,
    codec: input.codec,
    encoder: assignment[0]?.encoder,
    host: "linux-local",
    platform: process.platform,
    pcVerified: false,
    macVerified: false,
    preset: CONSERVATIVE_PRESET.id,
    configured: true,
    verified: false,
  };
}

export async function runEncodeOnce(directory = dataDir()): Promise<Record<string, unknown>> {
  const store = createJobStore(directory);
  await store.requeueStale("linux-local", (job) => job.kind === "transcode" && staleLease(directory, job));
  const job = await store.claimNext("linux-local", (item) => item.kind === "transcode");
  if (!job?.workerToken) return { processed: false, state: "idle" };
  const jobDir = path.join(directory, "encode-work", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeLease(directory, job.id, job.workerToken);
  if (process.env.SKLAD_ENCODE_EXIT === "86") process.exit(86);
  const hold = Number(process.env.SKLAD_ENCODE_HOLD_MS || 0);
  if (hold > 0) await delay(hold);
  try {
    return await executeClaimed(store, directory, jobDir, job, job.workerToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Сбой кодирования.";
    await store.fail(job.id, job.workerToken, message).catch(() => undefined);
    await cleanupOwned(jobDir);
    await writeJournal(directory, job.id, { verified: false, error: message, sourceDeleted: false });
    return { processed: true, state: "error", jobId: job.id, verified: false, error: message };
  }
}

async function executeClaimed(store: JobStore, directory: string, jobDir: string, job: Job, token: string): Promise<Record<string, unknown>> {
  const profile = /^c:(av1|hevc|h264):(sw|hw)$/.exec(job.payload.handbrakeProfile);
  if (!profile) throw new Error("Профиль кодирования не из настроенного пресета.");
  const codec = profile[1] as EncodeCodec;
  const allowSoftware = profile[2] === "sw";
  if (await cancelled(store, job.id)) return finishCancel(directory, jobDir, job.id);
  assertEncodePaths([job.payload.source, job.payload.destination, jobDir]);
  const binary = await findBinary(process.env.SKLAD_HANDBRAKE || "HandBrakeCLI");
  if (!binary) throw new Error("HandBrakeCLI не найден во время выполнения.");
  const capability = await readCapability(binary);
  const assignment = assignEncodeJobs(
    [{ id: job.id, codec, allowSoftware }],
    [{ id: "linux-local", os: "linux", slots: 1, probe: { hardwareAv1: capability.hardwareAv1, videoToolbox: null, amf: null, encoders: capability.encoders } }],
  );
  if (assignment[0]?.state !== "leased" || assignment[0].encoder == null) {
    throw new Error(assignment[0]?.reason || "Запрошенный кодек недоступен. Подмена не делается.");
  }
  const sourceInfo = await stat(job.payload.source);
  if (!sourceInfo.isFile() || sourceInfo.size > ENCODE_LIMITS.maxSourceBytes) throw new Error("Источник не подходит под предел этого прогона.");
  const room = scratchFits(await freeBytes(jobDir), sourceInfo.size);
  if (!room.ok) throw new Error(room.reason || "Мало места.");
  try {
    await stat(job.payload.destination);
    throw new Error("Файл назначения уже есть. Он не перезаписывается.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("не перезаписывается")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const facts = await probeMedia(job.payload.source);
  const blocked = requirementBlock(facts, capability, codec);
  if (blocked) throw new Error(blocked);
  const recorded = await fileIdentity(job.payload.source);
  const staging = path.join(jobDir, "staging" + path.extname(job.payload.source));
  const partial = path.join(jobDir, "output.part.mp4");
  await pipeline(createReadStream(job.payload.source), createWriteStream(staging));
  const args = encodeArgv({ binary, source: staging, output: partial, codec, sourceFacts: facts, encoders: capability.encoders });
  if (args.some((arg) => arg !== binary && arg.includes("x265")) && codec === "av1") throw new Error("AV1 не подменяется на HEVC.");
  const timeoutMs = Number(process.env.SKLAD_ENCODE_TIMEOUT_MS || ENCODE_LIMITS.timeoutMs);
  const child = await runHandBrake(args, timeoutMs, async (percent) => {
    await writeLease(directory, job.id, token);
    await store.updateProgress(job.id, token, {
      percent,
      processedBytes: 0,
      totalBytes: sourceInfo.size,
      speed: 0,
      etaSeconds: null,
      currentFile: path.basename(job.payload.source),
    });
  }, async () => cancelled(store, job.id));
  if (child.stopped) return finishCancel(directory, jobDir, job.id);
  if (child.timedOut) throw new Error("Кодирование превысило предел времени. Готовый файл не публикуется.");
  if (child.code !== 0) throw new Error(`HandBrake завершился с кодом ${child.code ?? "нет"}. Результат не принят.`);
  if (await cancelled(store, job.id)) return finishCancel(directory, jobDir, job.id);
  const outputFacts = await probeMedia(partial);
  const decodeOk = await decodeSample(partial);
  const check = verifyMedia({ codec, source: facts, output: outputFacts, decodeOk, exitCode: child.code });
  if (!check.verified) {
    throw new Error("Проверка контейнера, декодирования, длительности или дорожек не прошла. Код выхода 0 этого не заменяет.");
  }
  await commitOutput(partial, job.payload.destination);
  const outputInfo = await stat(job.payload.destination);
  const sizeBenefit = outputInfo.size < recorded.size;
  const retirement = await retireOwnedSource({
    directory,
    source: job.payload.source,
    destination: job.payload.destination,
    recorded,
    sizeBenefit,
    codec,
    check,
    torrentHash: job.payload.torrentHash,
  });
  await cleanupOwned(jobDir);
  await store.markVerified(job.id, token);
  const done = await store.complete(job.id, token);
  if (retirement.applied) await store.noteSourceRemoved(job.id);
  await writeJournal(directory, job.id, {
    verified: true,
    codec,
    encoder: assignment[0]?.encoder,
    sizeBenefit,
    sourceBytes: recorded.size,
    outputBytes: outputInfo.size,
    duration: outputFacts.duration,
    audio: outputFacts.audio,
    subtitles: outputFacts.subtitles,
    hdr: facts.hdr,
    retirement,
    sourceDeleted: retirement.applied,
    subjectiveQuality: false,
    pcVerified: false,
    macVerified: false,
  });
  return {
    processed: true,
    state: done?.state ?? "done",
    jobId: job.id,
    verified: true,
    codec,
    sizeBenefit,
    sourceDeleted: retirement.applied,
    pcVerified: false,
    macVerified: false,
    subjectiveQuality: false,
  };
}

async function finishCancel(directory: string, jobDir: string, jobId: string): Promise<Record<string, unknown>> {
  await cleanupOwned(jobDir);
  await writeJournal(directory, jobId, { verified: false, cancelled: true, sourceDeleted: false });
  return { processed: true, state: "cancelled", jobId, verified: false, sourceDeleted: false };
}

async function retireOwnedSource(input: {
  directory: string;
  source: string;
  destination: string;
  recorded: FileIdentity;
  sizeBenefit: boolean;
  codec: EncodeCodec;
  check: ReturnType<typeof verifyMedia>;
  torrentHash: string;
}): Promise<{ retire: boolean; applied: boolean; reason: string }> {
  const now = Math.floor(Date.now() / 1000);
  const seeding = input.torrentHash
    ? { counters: { ratio: null, downloaded: null, fresh: false, error: false }, completedAt: null, now }
    : null;
  const decision = decideSourceRetirement({
    destination: "committed",
    destinationError: "none",
    verification: {
      containerOk: input.check.containerOk,
      decodeOk: input.check.decodeOk,
      durationOk: input.check.durationOk,
      tracksOk: input.check.tracksOk,
      presetAccepted: input.check.presetAccepted,
      exitCode: 0,
      outputSmaller: input.sizeBenefit,
    },
    recordedSource: input.recorded,
    sourceNow: await fileIdentity(input.source).catch(() => null),
    outputPath: input.destination,
    seeding,
    files: input.torrentHash ? [{ path: input.recorded.path, processed: true, heldByOtherTorrent: false }] : null,
    removeWholeTorrent: false,
  });
  if (!input.sizeBenefit) return { retire: false, applied: false, reason: "Размер результата не меньше источника. Исходник не снимается." };
  if (!decision.retire) return { retire: false, applied: false, reason: decision.reason };
  const { coldGameBlocksDelete, listGames } = await import("@/lib/games/library");
  if (coldGameBlocksDelete(await listGames(input.directory), input.source)) {
    return { retire: false, applied: false, reason: "Холодная копия игры не снимается правилом видео." };
  }
  const ownedRoot = path.join(input.directory, "encode-owned");
  if (!pathInside(ownedRoot, input.source)) {
    return { retire: true, applied: false, reason: "Исходник вне каталога своих временных файлов. Удаление в production не включено." };
  }
  const current = await fileIdentity(input.source).catch(() => null);
  if (!current || current.path !== input.recorded.path || current.size !== input.recorded.size || current.sha256 !== input.recorded.sha256) {
    return { retire: false, applied: false, reason: "Перед удалением файл не совпал с записанным. Он не удаляется." };
  }
  const link = await lstat(input.source);
  if (link.isSymbolicLink() || !link.isFile()) return { retire: false, applied: false, reason: "Удаляется только обычный файл внутри каталога задания." };
  const real = await realpath(input.source);
  const root = await realpath(ownedRoot);
  if (!pathInside(root, real) || real === await realpath(input.destination).catch(() => "")) {
    return { retire: false, applied: false, reason: "Путь ведёт наружу или совпадает с результатом. Файл не удаляется." };
  }
  await unlink(real);
  return { retire: true, applied: true, reason: "Снят только свой временный файл после проверки и уменьшения размера." };
}

async function commitOutput(partial: string, destination: string): Promise<void> {
  const handle = await open(destination, "wx");
  await handle.close();
  await unlink(destination);
  try {
    await rename(partial, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await pipeline(createReadStream(partial), createWriteStream(destination, { flags: "wx" }));
    await unlink(partial);
  }
}

async function runHandBrake(
  args: string[],
  timeoutMs: number,
  onProgress: (percent: number) => Promise<void>,
  stop: () => Promise<boolean>,
): Promise<{ code: number | null; timedOut: boolean; stopped: boolean }> {
  const bin = args[0];
  if (!bin) throw new Error("Нет пути к HandBrakeCLI.");
  const child = spawn(bin, args.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let timedOut = false;
  let stopped = false;
  let buffer = "";
  const started = Date.now();
  const consume = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    buffer = acceptJson(buffer, (value) => {
      const working = value as { Progress?: { Working?: { Progress?: number } } };
      const ratio = working.Progress?.Working?.Progress;
      if (typeof ratio === "number" && Number.isFinite(ratio)) void onProgress(Math.max(0, Math.min(100, Math.round(ratio * 100))));
    });
    if (buffer.length > 64_000) buffer = buffer.slice(-32_000);
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const killer = setInterval(() => {
    void (async () => {
      if (Date.now() - started > timeoutMs) {
        timedOut = true;
        child.kill("SIGKILL");
      } else if (await stop()) {
        stopped = true;
        child.kill("SIGKILL");
      }
    })();
  }, 200);
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (exit) => resolve(exit));
  });
  clearInterval(killer);
  return { code, timedOut, stopped };
}

function acceptJson(buffer: string, onObject: (value: unknown) => void): string {
  let start = buffer.indexOf("{");
  while (start >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = start; i < buffer.length; i += 1) {
      if (buffer[i] === "{") depth += 1;
      else if (buffer[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return buffer.slice(start);
    try {
      onObject(JSON.parse(buffer.slice(start, end + 1)));
    } catch {
      /* keep scanning */
    }
    buffer = buffer.slice(end + 1);
    start = buffer.indexOf("{");
  }
  return buffer;
}

async function probeMedia(file: string): Promise<MediaFacts> {
  const bin = await findBinary("ffprobe");
  if (!bin) throw new Error("ffprobe не найден. Проверка результата невозможна, успех не ставится.");
  const result = await collect(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file], 20_000);
  if (result.code !== 0) throw new Error("ffprobe не прочитал файл. Кодирование или приёмка не продолжаются.");
  return mediaFromProbe(JSON.parse(result.stdout));
}

async function decodeSample(file: string): Promise<boolean> {
  const bin = await findBinary("ffmpeg");
  if (!bin) return false;
  const result = await collect(bin, ["-v", "error", "-t", "1", "-i", file, "-f", "null", "-"], 20_000);
  return result.code === 0;
}

async function readCapability(binary: string): Promise<HandBrakeCapability> {
  const help = await collect(binary, ["--help"], 15_000);
  const version = await collect(binary, ["--version"], 15_000);
  return capabilityFromHelp(`${help.stdout}\n${help.stderr}`, `${version.stdout}\n${version.stderr}`);
}

function collect(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 200_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileIdentity(file: string): Promise<FileIdentity> {
  const info = await stat(file);
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return { path: path.resolve(file), size: info.size, sha256: hash.digest("hex") };
}

async function findBinary(name: string): Promise<string | null> {
  if (!name.trim()) return null;
  if (name.includes("/") || name.includes("\\")) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return null;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const space = await statfs(dir);
    return Number(space.bavail) * Number(space.bsize);
  } catch {
    return null;
  }
}

async function cancelled(store: JobStore, id: string): Promise<boolean> {
  const list = await store.list({ limit: 200 });
  const job = list.jobs.find((item) => item.id === id);
  return !job || job.cancelled || job.state === "error";
}

function staleLease(directory: string, job: Job): boolean {
  try {
    const raw = JSON.parse(readFileSync(path.join(directory, "encode-leases", `${job.id}.json`), "utf8")) as { pid?: number };
    if (!raw.pid || raw.pid === process.pid) return false;
    process.kill(raw.pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "ENOENT") return Date.now() - Date.parse(job.updatedAt) > 15_000;
    return false;
  }
}

async function writeLease(directory: string, id: string, token: string): Promise<void> {
  const dir = path.join(directory, "encode-leases");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
}

async function writeJournal(directory: string, id: string, body: Record<string, unknown>): Promise<void> {
  const dir = path.join(directory, "encode-journal");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...body, at: new Date().toISOString() }), "utf8");
  await rename(tmp, file);
}

async function cleanupOwned(jobDir: string): Promise<void> {
  await rm(jobDir, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
