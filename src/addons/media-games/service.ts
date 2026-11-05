import { randomUUID } from "node:crypto";

import { buildCompactArgv, DEFAULT_COMPACT_EXE } from "@/addons/media-games/compact";
import { defaultPcHost, defaultMacHost, defaultToolsConfig } from "@/addons/media-games/defaults";
import { ToolsError, toolsErrorMessage } from "@/addons/media-games/errors";
import {
  HANDBRAKE_DISCOVERY_NOTE,
  buildHandBrakeArgv,
  handbrakeCandidates,
  requireHandbrakePreset,
  resolveHandBrakeBinary,
} from "@/addons/media-games/handbrake";
import { binaryExists, createFsMover, readTracked, startTracked } from "@/addons/media-games/local-runner";
import { advanceFolderJob, advanceMockJob, createMockMover } from "@/addons/media-games/mock-runner";
import {
  applyCopy,
  applyVerify,
  confirmSourceDelete,
  libraryFromPlan,
  markSourceDeleted,
  planMove,
} from "@/addons/media-games/move";
import { assertToolPath, pathLeaf } from "@/addons/media-games/paths";
import { agentConfirm, agentEnqueue, agentTick, type AgentEnqueueBody, type AgentJobPayload } from "@/addons/media-games/pc-client";
import { isCompactAlgorithm } from "@/addons/media-games/presets";
import { loadConfig, loadJobs, loadLibrary, saveConfig, saveJobs, saveLibrary, writeMockMarker } from "@/addons/media-games/store";
import type {
  HostProbe,
  JobRecord,
  JobRunner,
  LibraryRecord,
  ToolHostConfig,
  ToolHostId,
  ToolOs,
  ToolsConfig,
  ToolsSnapshot,
} from "@/addons/media-games/types";
import { isToolHostId } from "@/addons/media-games/types";

let tail: Promise<void> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getToolsSnapshot(): Promise<ToolsSnapshot> {
  return exclusive(pump);
}

export function saveToolsConfig(input: unknown): Promise<ToolsSnapshot> {
  return exclusive(async () => {
    const config = sanitizeConfig(input);
    await saveConfig(config);
    const jobs = await loadJobs();
    const library = await loadLibrary();
    return toSnapshot(config, jobs, library);
  });
}

export function enqueueTranscode(input: {
  hostId: string;
  inputPath: string;
  outputPath: string;
  presetId: string;
}): Promise<JobRecord> {
  return exclusive(async () => {
    const config = usableConfig(await loadConfig());
    const host = requireHost(config, input.hostId);
    const preset = requireHandbrakePreset(input.presetId);
    const inputPath = assertToolPath(host.os, input.inputPath, "исходный файл");
    const outputPath = assertToolPath(host.os, input.outputPath, "файл результата");
    if (inputPath === outputPath || (host.os === "win32" && inputPath.toLowerCase() === outputPath.toLowerCase())) {
      throw new ToolsError("validation", "Файл результата должен отличаться от исходного.");
    }
    const resolved = resolveHandBrakeBinary(host, binaryExists);
    const plannedArgv = buildHandBrakeArgv({
      binary: resolved.binary,
      inputPath,
      outputPath,
      preset: preset.handbrakeName,
    });
    const runner = selectRunner(config, host);
    const job = createJob({
      kind: "transcode",
      hostId: host.id,
      title: `${pathLeaf(host.os, inputPath)} · ${preset.label}`,
      runner,
      plannedArgv,
      binaryFound: resolved.found,
      inputPath,
      outputPath,
      presetId: preset.id,
      presetLabel: preset.label,
    });
    await persistNew(job);
    return job;
  });
}

export function enqueueMove(input: {
  hostId: string;
  name: string;
  sourcePath: string;
  destinationPath: string;
}): Promise<JobRecord> {
  return exclusive(async () => {
    const config = usableConfig(await loadConfig());
    const host = requireHost(config, input.hostId);
    const plan = planMove({
      hostId: host.id,
      os: host.os,
      name: input.name,
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
    });
    const runner = selectRunner(config, host);
    const job = createJob({
      kind: "move",
      hostId: host.id,
      title: plan.name,
      runner,
      plannedArgv: ["sklad-move", "--copy", plan.sourcePath, "--dest", plan.destinationPath, "--delete", "false"],
      sourcePath: plan.sourcePath,
      destinationPath: plan.destinationPath,
      deleteSource: false,
      sourceDeleted: false,
      verified: false,
    });
    await persistNew(job);
    return job;
  });
}

export function enqueueCompress(input: { hostId: string; folderPath: string; algorithm: string }): Promise<JobRecord> {
  return exclusive(async () => {
    const config = usableConfig(await loadConfig());
    const host = requireHost(config, input.hostId);
    if (!isCompactAlgorithm(input.algorithm)) {
      throw new ToolsError("validation", "Неизвестный алгоритм сжатия.");
    }
    const binary = host.compactPath.trim() || DEFAULT_COMPACT_EXE;
    const plannedArgv = buildCompactArgv({
      os: host.os,
      binary,
      folder: input.folderPath,
      algorithm: input.algorithm,
    });
    const folderPath = plannedArgv[3].slice("/S:".length);
    const runner = selectRunner(config, host);
    const job = createJob({
      kind: "compress",
      hostId: host.id,
      title: `Сжать ${pathLeaf(host.os, folderPath)}`,
      runner,
      plannedArgv,
      binaryFound: host.os === "win32" && binaryExists(binary),
      folderPath,
      algorithm: input.algorithm,
    });
    await persistNew(job);
    return job;
  });
}

export function confirmMove(id: string, deleteSource: boolean): Promise<JobRecord> {
  return exclusive(async () => {
    const jobs = await loadJobs();
    const library = await loadLibrary();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new ToolsError("not_found", "Задание не найдено.");
    const job = jobs[index];
    if (job.kind !== "move") throw new ToolsError("validation", "Подтверждение относится только к переносу папки.");
    if (job.state !== "awaiting-confirm" || !job.verified || job.verify?.ok !== true) {
      throw new ToolsError("validation", "Источник не удаляется: копия ещё не проверена.");
    }
    const now = Date.now();
    const config = usableConfig(await loadConfig());
    const next = await finishMove(job, config, deleteSource, now);
    const record = libraryRecordFor(next, now);
    if (record) upsertLibrary(library, record);
    jobs[index] = next;
    await saveJobs(jobs);
    await saveLibrary(library);
    return next;
  });
}

async function pump(): Promise<ToolsSnapshot> {
  const config = usableConfig(await loadConfig());
  const jobs = await loadJobs();
  const library = await loadLibrary();
  const now = Date.now();
  const nextJobs: JobRecord[] = [];
  let jobsChanged = false;
  let libraryChanged = false;
  for (const job of jobs) {
    if (!isActive(job)) {
      nextJobs.push(job);
      continue;
    }
    try {
      const step = await advance(job, config, now);
      if (
        step.job.kind === "transcode" &&
        step.job.state === "completed" &&
        step.job.runner === "mock" &&
        job.state !== "completed"
      ) {
        await writeMockMarker(step.job);
      }
      nextJobs.push(step.job);
      jobsChanged = true;
      if (step.library) {
        upsertLibrary(library, step.library);
        libraryChanged = true;
      }
    } catch (error) {
      nextJobs.push({
        ...job,
        state: "failed",
        error: toolsErrorMessage(error),
        deleteSource: false,
        sourceDeleted: false,
        updatedAt: now,
      });
      jobsChanged = true;
    }
  }
  if (jobsChanged) await saveJobs(nextJobs);
  if (libraryChanged) await saveLibrary(library);
  return toSnapshot(config, nextJobs, library);
}

async function advance(job: JobRecord, config: ToolsConfig, now: number) {
  if (job.runner === "mock") return advanceMockJob(job, now);
  if (job.runner === "pc-agent") return advanceAgent(job, config, now);
  return advanceLocal(job, config, now);
}

async function advanceLocal(job: JobRecord, config: ToolsConfig, now: number) {
  const host = requireHost(config, job.hostId);
  if (job.kind === "move") return advanceFolderJob(job, now, createFsMover(host.os));
  if (job.kind === "compress") {
    buildCompactArgv({
      os: host.os,
      binary: job.plannedArgv[0] || host.compactPath || DEFAULT_COMPACT_EXE,
      folder: job.folderPath || "",
      algorithm: job.algorithm || "LZX",
    });
  }
  if (!job.binaryFound) {
    const missing = job.kind === "compress" ? "compact.exe не найден по указанному пути." : "HandBrakeCLI не найден по указанному пути.";
    return { job: fail(job, now, missing), library: null };
  }
  if (job.kind !== "transcode" && job.kind !== "compress") {
    return { job: fail(job, now, "Это задание нельзя выполнить локально."), library: null };
  }
  if (!job.spawned) {
    startTracked(job.id, job.plannedArgv, host.os, job.kind);
    return {
      job: { ...job, spawned: true, state: "running" as const, progress: 0.05, updatedAt: now },
      library: null,
    };
  }
  const tracked = readTracked(job.id);
  if (!tracked) return { job: fail(job, now, "Процесс не найден после перезапуска панели."), library: null };
  if (tracked.error || (tracked.code !== null && tracked.code !== 0)) {
    return { job: fail(job, now, tracked.error || `Программа завершилась с кодом ${tracked.code}.`), library: null };
  }
  if (tracked.code === 0) {
    return {
      job: {
        ...job,
        state: "completed" as const,
        progress: 1,
        outputMarker: job.outputPath || job.folderPath,
        updatedAt: now,
        error: null,
      },
      library: null,
    };
  }
  return { job: { ...job, state: "running" as const, progress: tracked.progress, updatedAt: now }, library: null };
}

async function advanceAgent(job: JobRecord, config: ToolsConfig, now: number) {
  const host = requireHost(config, job.hostId);
  if (!host.agentUrl) return { job: fail(job, now, "Не указан адрес агента Windows."), library: null };
  const remote = job.remoteId ? await agentTick(host.agentUrl, job.remoteId) : await agentEnqueue(host.agentUrl, specFrom(job, host));
  const next = applyRemote(job, remote, now);
  return { job: next, library: libraryRecordFor(next, now) };
}

async function finishMove(job: JobRecord, config: ToolsConfig, deleteSource: boolean, now: number): Promise<JobRecord> {
  if (job.runner === "pc-agent") {
    const host = requireHost(config, job.hostId);
    if (!host.agentUrl || !job.remoteId) throw new ToolsError("unavailable", "Агент Windows недоступен.");
    const remote = await agentConfirm(host.agentUrl, job.remoteId, deleteSource);
    return applyRemote(job, remote, now);
  }
  const os: ToolOs = job.hostId === "pc-agent" ? "win32" : "darwin";
  let plan = planMove({
    hostId: job.hostId,
    os,
    name: job.title,
    sourcePath: job.sourcePath || "",
    destinationPath: job.destinationPath || "",
  });
  plan = applyCopy(plan, {
    files: job.copyFiles ?? 0,
    bytes: job.copyBytes ?? 0,
    marker: job.outputMarker || "",
  });
  if (!job.verify) throw new ToolsError("validation", "Источник не удаляется: копия ещё не проверена.");
  plan = applyVerify(plan, job.verify);
  plan = confirmSourceDelete(plan, deleteSource);
  if (plan.deleteSource) {
    const mover = job.runner === "local" ? createFsMover(os) : createMockMover();
    await mover.deleteSource(plan.sourcePath);
    plan = markSourceDeleted(plan);
  }
  const record = libraryFromPlan(plan, job.id, now);
  return {
    ...job,
    state: "completed",
    progress: 1,
    verified: true,
    deleteSource: plan.deleteSource,
    sourceDeleted: plan.sourceDeleted,
    libraryId: record.id,
    updatedAt: now,
    error: null,
  };
}

function libraryRecordFor(job: JobRecord, now: number): LibraryRecord | null {
  if (job.kind !== "move" || !job.verified || !job.sourcePath || !job.destinationPath) return null;
  if (job.state !== "awaiting-confirm" && job.state !== "completed") return null;
  return {
    id: job.libraryId || `lib-${job.id}`,
    name: job.title,
    hostId: job.hostId,
    oldPath: job.sourcePath,
    newPath: job.destinationPath,
    status: job.sourceDeleted ? "moved" : "verified",
    jobId: job.id,
    updatedAt: now,
  };
}

function applyRemote(job: JobRecord, remote: AgentJobPayload, now: number): JobRecord {
  return {
    ...job,
    remoteId: remote.id,
    state: remote.state,
    progress: remote.progress,
    error: remote.error,
    plannedArgv: remote.plannedArgv.length > 0 ? remote.plannedArgv : job.plannedArgv,
    outputMarker: remote.outputMarker,
    verified: remote.verified,
    deleteSource: remote.deleteSource,
    sourceDeleted: remote.sourceDeleted,
    verify: remote.verify,
    bytesBefore: remote.bytesBefore,
    bytesAfter: remote.bytesAfter,
    spawned: remote.spawned,
    libraryId: remote.verified ? job.libraryId || `lib-${job.id}` : job.libraryId,
    updatedAt: now,
  };
}

function specFrom(job: JobRecord, host: ToolHostConfig): AgentEnqueueBody {
  const preset = job.presetId ? requireHandbrakePreset(job.presetId).handbrakeName : undefined;
  return {
    kind: job.kind,
    title: job.title,
    handbrakePath: job.kind === "transcode" ? job.plannedArgv[0] || host.handbrakePath : host.handbrakePath,
    inputPath: job.inputPath ?? undefined,
    outputPath: job.outputPath ?? undefined,
    preset,
    compactPath: job.kind === "compress" ? job.plannedArgv[0] || host.compactPath : host.compactPath,
    folderPath: job.folderPath ?? undefined,
    algorithm: job.algorithm ?? undefined,
    sourcePath: job.sourcePath ?? undefined,
    destinationPath: job.destinationPath ?? undefined,
  };
}

function selectRunner(config: ToolsConfig, host: ToolHostConfig): JobRunner {
  if (config.demoMode) return "mock";
  if (host.id === "pc-agent") {
    if (!host.agentUrl) {
      throw new ToolsError("validation", "Укажите адрес агента Windows в настройках или включите демо-режим.");
    }
    return "pc-agent";
  }
  return "local";
}

function requireHost(config: ToolsConfig, id: string): ToolHostConfig {
  if (!isToolHostId(id)) throw new ToolsError("validation", "Неизвестный хост. Доступны mac-local и pc-agent.");
  const host = config.hosts.find((item) => item.id === id);
  if (!host) throw new ToolsError("not_found", "Хост не найден в настройках медиа.");
  return host;
}

function usableConfig(config: ToolsConfig): ToolsConfig {
  if (!config || !Array.isArray(config.hosts) || typeof config.demoMode !== "boolean") return defaultToolsConfig();
  const mac = config.hosts.find((host) => host.id === "mac-local");
  const pc = config.hosts.find((host) => host.id === "pc-agent");
  if (!mac || !pc) return defaultToolsConfig();
  return {
    demoMode: config.demoMode,
    hosts: [
      { ...mac, id: "mac-local", os: "darwin", agentUrl: null },
      { ...pc, id: "pc-agent", os: "win32" },
    ],
  };
}

function createJob(patch: Omit<Partial<JobRecord>, "id" | "createdAt" | "updatedAt"> & Pick<JobRecord, "kind" | "hostId" | "title" | "runner" | "plannedArgv">): JobRecord {
  const now = Date.now();
  return {
    id: randomUUID(),
    state: "queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    error: null,
    binaryFound: null,
    outputMarker: null,
    inputPath: null,
    outputPath: null,
    presetId: null,
    presetLabel: null,
    sourcePath: null,
    destinationPath: null,
    folderPath: null,
    algorithm: null,
    verified: false,
    deleteSource: false,
    sourceDeleted: false,
    verify: null,
    bytesBefore: null,
    bytesAfter: null,
    libraryId: null,
    copyFiles: null,
    copyBytes: null,
    spawned: false,
    remoteId: null,
    ...patch,
  };
}

async function persistNew(job: JobRecord): Promise<void> {
  const jobs = await loadJobs();
  jobs.unshift(job);
  await saveJobs(jobs);
}

function isActive(job: JobRecord): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "verifying";
}

function fail(job: JobRecord, now: number, message: string): JobRecord {
  return {
    ...job,
    state: "failed",
    error: message,
    deleteSource: false,
    sourceDeleted: false,
    updatedAt: now,
  };
}

function upsertLibrary(library: LibraryRecord[], record: LibraryRecord): void {
  const index = library.findIndex((item) => item.id === record.id);
  if (index >= 0) library[index] = record;
  else library.push(record);
}

function toSnapshot(config: ToolsConfig, jobs: JobRecord[], library: LibraryRecord[]): ToolsSnapshot {
  return {
    config,
    probes: config.hosts.map(probeHost),
    jobs: jobs.slice().sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)),
    library: library.slice().sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

function probeHost(host: ToolHostConfig): HostProbe {
  const resolved = resolveHandBrakeBinary(host, binaryExists);
  const compactAvailable = host.os === "win32";
  return {
    id: host.id,
    name: host.name,
    os: host.os,
    handbrakePath: resolved.binary,
    handbrakeFound: resolved.found,
    handbrakeCandidates: handbrakeCandidates(host.os, host.handbrakePath, host.handbrakeExtra),
    compactPath: host.compactPath,
    compactFound: compactAvailable && binaryExists(host.compactPath),
    compactAvailable,
    compactReason: compactAvailable ? null : "Только Windows, NTFS.",
    discoveryNote: HANDBRAKE_DISCOVERY_NOTE[host.os],
  };
}

export function sanitizeConfig(input: unknown): ToolsConfig {
  if (!input || typeof input !== "object") throw new ToolsError("validation", "Пустые настройки.");
  const body = input as { demoMode?: unknown; hosts?: unknown };
  if (typeof body.demoMode !== "boolean") throw new ToolsError("validation", "Укажите, включён ли демо-режим.");
  if (!Array.isArray(body.hosts)) throw new ToolsError("validation", "Нужны оба хоста: Mac и Windows.");
  return {
    demoMode: body.demoMode,
    hosts: [sanitizeHost(body.hosts, "mac-local"), sanitizeHost(body.hosts, "pc-agent")],
  };
}

function sanitizeHost(hosts: unknown[], id: ToolHostId): ToolHostConfig {
  const found = hosts.find((item) => isRecord(item) && item.id === id);
  if (!isRecord(found)) throw new ToolsError("validation", "Нужны оба хоста: Mac и Windows.");
  const os: ToolOs = id === "pc-agent" ? "win32" : "darwin";
  if (found.os !== undefined && found.os !== os) {
    throw new ToolsError("validation", "Систему хоста менять нельзя.");
  }
  const defaults = id === "pc-agent" ? defaultPcHost() : defaultMacHost();
  const name = String(found.name ?? defaults.name).trim().slice(0, 80);
  if (!name) throw new ToolsError("validation", "Укажите имя хоста.");
  const rawFolders = Array.isArray(found.libraryFolders) ? found.libraryFolders : [];
  const libraryFolders = rawFolders
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 24)
    .map((folder) => assertToolPath(os, folder, "каталог библиотеки"));
  return {
    id,
    name,
    os,
    agentUrl: id === "pc-agent" ? sanitizeAgentUrl(String(found.agentUrl ?? "")) : null,
    handbrakePath: String(found.handbrakePath ?? "").trim(),
    handbrakeExtra: String(found.handbrakeExtra ?? "").trim(),
    compactPath: id === "pc-agent" ? String(found.compactPath ?? "").trim() : "",
    compactGuiPath: id === "pc-agent" ? String(found.compactGuiPath ?? "").trim() : "",
    libraryFolders,
  };
}

function sanitizeAgentUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ToolsError("validation", "Адрес агента должен быть http:// или https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolsError("validation", "Адрес агента должен быть http:// или https://. Прокси и VLESS не используются.");
  }
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
