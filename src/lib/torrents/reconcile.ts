import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { createJobStore } from "@/lib/jobs/engine";
import { localJobHost } from "@/lib/jobs/local-host";
import type { Job } from "@/lib/jobs/model";
import { coldGameBlocksDelete, listGames } from "@/lib/games/library";
import {
  decideSourceRetirement,
  evaluateSeedingGate,
  observeCompletion,
  type CompletionMemory,
  type FileIdentity,
  type SeedingCounters,
} from "@/lib/policies/source-retirement";
import { joinRemotePath } from "@/lib/qbittorrent/paths";
import type { HostOs } from "@/lib/qbittorrent/types";
import { dataDir } from "@/lib/qbittorrent/store";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";

export interface TorrentRule {
  id: string;
  /** Only torrents whose save path is inside this prefix become jobs. */
  savePrefix: string;
  outputRoot: string;
  /** Source files outside this root are never deleted. */
  managedRoot: string;
  /** Default false. Unknown production paths stay retain. */
  retire: boolean;
}

export interface ProtocolFile {
  name: string;
  size: number;
  progress: number;
}

export interface ProtocolTorrent {
  hash: string;
  name: string;
  progress: number;
  state: string;
  ratio: number | null;
  downloaded: number | null;
  uploaded: number | null;
  addedOn: number;
  completionOn: number;
  savePath: string;
  files: ProtocolFile[];
}

export interface ProtocolSnapshot {
  hostId: string;
  os: HostOs;
  torrents: ProtocolTorrent[];
}

export function forbiddenVolume(value: string): boolean {
  return /^(?:\\\\\?\\)?[EeZz]:(?:[\\/]|$)/.test(value.trim());
}

export async function reconcileLocalProtocol(directory = dataDir(), now = Math.floor(Date.now() / 1000)): Promise<{ enqueued: number; blocked: number }> {
  const protocol = await readJson<ProtocolSnapshot | null>(path.join(directory, "torrent-local.json"), null);
  const rules = await readJson<{ rules?: TorrentRule[] }>(path.join(directory, "torrent-rules.json"), { rules: [] });
  if (!protocol) return { enqueued: 0, blocked: 0 };
  return reconcileProtocol(directory, protocol, rules.rules ?? [], now);
}

export async function reconcileProtocol(
  directory: string,
  protocol: ProtocolSnapshot,
  rules: readonly TorrentRule[],
  now: number,
): Promise<{ enqueued: number; blocked: number }> {
  const memory = await readMemory(directory);
  let enqueued = 0;
  let blocked = 0;
  const notes: Record<string, unknown>[] = [];
  for (const torrent of protocol.torrents) {
    const hash = torrent.hash.toLowerCase();
    if (forbiddenVolume(torrent.savePath) || torrent.files.some((file) => forbiddenVolume(joinRemotePath(protocol.os, torrent.savePath, file.name)))) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "E и Z не открываются. Метаданные тома не читались." });
      continue;
    }
    const previous = memory[hash] ?? null;
    const filesDone = torrent.files.length > 0 && torrent.files.every((file) => file.progress >= 1);
    if (torrent.progress >= 1 && !filesDone) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "Не все файлы раздачи докачаны. Каталог и снятие не ставятся." });
      continue;
    }
    const complete = torrent.progress >= 1 && filesDone;
    const next = observeCompletion(previous, {
      hash,
      complete,
      clientCompletedAt: torrent.completionOn > 0 ? torrent.completionOn : null,
      now,
    });
    memory[hash] = next;
    if (!complete) {
      notes.push({ hash, action: "downloading", completedAt: next.completedAt });
      continue;
    }
    if (torrent.files.length === 0 || torrent.files.some((file) => file.progress < 1)) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "Не все файлы раздачи докачаны. Каталог и снятие не ставятся." });
      continue;
    }
    const rule = rules.find((item) => torrent.savePath.startsWith(item.savePrefix));
    if (!rule) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "Нет правила для этого пути. Действие не ставится." });
      continue;
    }
    const source = joinRemotePath(protocol.os, torrent.savePath, torrent.files.length === 1 ? torrent.files[0]!.name : "");
    const destination = path.join(rule.outputRoot, hash);
    if (source === destination || forbiddenVolume(source) || forbiddenVolume(destination) || forbiddenVolume(rule.outputRoot) || forbiddenVolume(rule.managedRoot)) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "Источник, назначение или корень правила закрыты." });
      continue;
    }
    const host = localJobHost();
    if (!host) {
      blocked += 1;
      notes.push({ hash, action: "blocked", reason: "Платформа процесса не Mac, Windows и не Linux. Задание не ставится." });
      continue;
    }
    const store = createJobStore(directory);
    const queued = await store.enqueue(
      {
        kind: "copy",
        host,
        source,
        destination,
        diskId: `torrent:${hash}`.slice(0, 80),
        torrentHash: hash,
      },
      { anyState: true },
    );
    if (queued.created) enqueued += 1;
    notes.push({ hash, action: "queued", created: queued.created, jobId: queued.job.id, completedAt: next.completedAt, completedAtSource: next.completedAtSource });
  }
  const seen = await readJson<Record<string, ProtocolTorrent>>(path.join(directory, "torrent-seen.json"), {});
  for (const torrent of protocol.torrents) seen[torrent.hash.toLowerCase()] = torrent;
  await writeJson(path.join(directory, "torrent-seen.json"), seen);
  await writeJson(path.join(directory, "torrent-completion.json"), memory);
  await writeJson(path.join(directory, "torrent-notes.json"), { notes });
  return { enqueued, blocked };
}

export async function runTorrentOnce(directory = dataDir(), now = Math.floor(Date.now() / 1000)): Promise<{ processed: boolean; verified?: boolean; deleted?: boolean; eligible?: boolean }> {
  const host = localJobHost();
  if (!host) return { processed: false };
  const store = createJobStore(directory);
  const job = await store.claimNext(host, (item) => item.kind === "copy" && item.payload.diskId.startsWith("torrent:"));
  if (!job?.workerToken) return { processed: false };
  try {
    const outcome = await verifyTorrentJob(directory, job, now);
    if (!outcome.verified) {
      await store.fail(job.id, job.workerToken, outcome.reason);
      return { processed: true, verified: false, deleted: false, eligible: false };
    }
    await store.markVerified(job.id, job.workerToken);
    await store.complete(job.id, job.workerToken);
    return { processed: true, verified: true, deleted: outcome.deleted, eligible: outcome.eligible };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Проверка раздачи не выполнилась.";
    await store.fail(job.id, job.workerToken, message).catch(() => undefined);
    return { processed: true, verified: false, deleted: false };
  }
}

async function verifyTorrentJob(directory: string, job: Job, now: number): Promise<{ verified: boolean; deleted: boolean; eligible: boolean; reason: string }> {
  assertEncodePaths([job.payload.source, job.payload.destination]);
  const rules = await readJson<{ rules?: TorrentRule[] }>(path.join(directory, "torrent-rules.json"), { rules: [] });
  const seen = await readJson<Record<string, ProtocolTorrent>>(path.join(directory, "torrent-seen.json"), {});
  const rule = (rules.rules ?? []).find((item) => job.payload.source.startsWith(item.managedRoot) || job.payload.source.startsWith(item.savePrefix));
  const sourceInfo = await fileIdentity(job.payload.source);
  await mkdir(path.dirname(job.payload.destination), { recursive: true });
  const temp = `${job.payload.destination}.${process.pid}.part`;
  await pipeline(createReadStream(job.payload.source), createWriteStream(temp, { flags: "wx" }));
  const copied = await fileIdentity(temp);
  if (copied.sha256 !== sourceInfo.sha256 || copied.size !== sourceInfo.size) {
    await unlink(temp).catch(() => undefined);
    await writeJournal(directory, job, { verified: false, deleted: false, eligible: false, reason: "Копия не совпала с источником. Исходник остаётся." });
    return { verified: false, deleted: false, eligible: false, reason: "Копия не совпала с источником. Исходник остаётся." };
  }
  try {
    await lstat(job.payload.destination);
    await unlink(temp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rename(temp, job.payload.destination);
  }
  const output = await fileIdentity(job.payload.destination);
  if (output.sha256 !== sourceInfo.sha256) {
    await writeJournal(directory, job, { verified: false, deleted: false, eligible: false, reason: "Готовый файл повреждён. Исходник остаётся." });
    return { verified: false, deleted: false, eligible: false, reason: "Готовый файл повреждён. Исходник остаётся." };
  }
  const torrent = seen[job.payload.torrentHash];
  const memory = await readMemory(directory);
  const remembered = memory[job.payload.torrentHash] ?? null;
  const counters: SeedingCounters = {
    ratio: torrent?.ratio ?? null,
    downloaded: torrent?.downloaded ?? null,
    fresh: torrent != null && torrent.ratio != null && torrent.downloaded != null,
    error: false,
  };
  const others = Object.values(seen).filter((item) => item.hash.toLowerCase() !== job.payload.torrentHash);
  const shared = others.some((item) => item.files.some((file) => joinRemotePath("darwin", item.savePath, file.name) === job.payload.source));
  const partial = (torrent?.files.length ?? 0) > 1 && (torrent?.files.some((file) => file.progress < 1) ?? false);
  const gate = evaluateSeedingGate({ counters, completedAt: remembered?.completedAt ?? null, now });
  const smaller = output.size < sourceInfo.size;
  const inside = Boolean(rule && path.resolve(job.payload.source).startsWith(path.resolve(rule.managedRoot) + path.sep));
  const games = await listGames(directory);
  const game = coldGameBlocksDelete(games, job.payload.source);
  const decision = decideSourceRetirement({
    destination: "committed",
    destinationError: "none",
    verification: {
      containerOk: true,
      decodeOk: true,
      durationOk: true,
      tracksOk: !partial,
      presetAccepted: true,
      exitCode: 0,
      outputSmaller: smaller,
    },
    recordedSource: sourceInfo,
    sourceNow: await fileIdentity(job.payload.source).catch(() => null),
    outputPath: job.payload.destination,
    seeding: { counters, completedAt: remembered?.completedAt ?? null, now },
    files: [
      { path: sourceInfo.path, processed: true, heldByOtherTorrent: shared },
      ...((torrent?.files.length ?? 0) > 1 ? [{ path: `${sourceInfo.path}#rest`, processed: !partial, heldByOtherTorrent: false }] : []),
    ],
    removeWholeTorrent: false,
  });
  const eligible = gate.satisfied && decision.retire && !shared && !partial && !game;
  let deleted = false;
  let reason = decision.reason;
  if (!rule?.retire) reason = "Снятие исходника политикой не включено. Файл остаётся.";
  else if (!inside) reason = "Исходник вне разрешённого корня. Он не удаляется.";
  else if (!smaller) reason = "Проверенная копия не меньше исходника. Исходник остаётся.";
  else if (!eligible) reason = shared ? "Файл ещё держит другая раздача. Он не удаляется." : decision.reason;
  else if (game) reason = "Холодная копия игры не снимается правилом раздачи.";
  else {
    const current = await fileIdentity(job.payload.source);
    if (current.sha256 !== sourceInfo.sha256 || current.size !== sourceInfo.size) {
      reason = "Исходник изменился до удаления. Он остаётся.";
    } else {
      await writeJournal(directory, job, { verified: true, deleted: false, eligible: true, reason: "Удаление начато.", gate: gate.branch });
      await unlink(job.payload.source);
      deleted = true;
      reason = "Исходник снят внутри разрешённого корня после порога и проверки.";
    }
  }
  await writeJournal(directory, job, { verified: true, deleted, eligible: gate.satisfied, reason, gate: gate.branch, completedAt: remembered?.completedAt ?? null });
  return { verified: true, deleted, eligible: gate.satisfied, reason };
}

async function fileIdentity(file: string): Promise<FileIdentity> {
  const info = await stat(file);
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return { path: path.resolve(file), size: info.size, sha256: hash.digest("hex") };
}

async function readMemory(directory: string): Promise<Record<string, CompletionMemory>> {
  return readJson(path.join(directory, "torrent-completion.json"), {});
}

async function writeJournal(directory: string, job: Job, body: Record<string, unknown>): Promise<void> {
  const dir = path.join(directory, "torrent-journal");
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, `${job.payload.torrentHash || job.id}.json`), body);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, file);
}
