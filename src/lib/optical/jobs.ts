import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { ACTIVE_JOB, type BackgroundJob } from "@/lib/jobs/types";
import { getJob, mutateJobs, readJobs } from "@/lib/jobs/store";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot, JobStatus } from "@/lib/progress/types";
import { dataDir } from "@/lib/qbittorrent/store";
import { getDashboard, getTorrentDetail } from "@/lib/qbittorrent/service";
import { OpticalError } from "@/lib/optical/errors";
import {
  BD_R_SL_TOTAL_SECTORS,
  CD_DEFAULT_SECTORS,
  DISC_IMAGE_STUDIO_LICENSE,
  DISC_IMAGE_STUDIO_RELEASES,
  DISC_IMAGE_STUDIO_REPO,
  DVD_SL_TOTAL_SECTORS,
  buildDiscImageStudioPlan,
  commandLine,
  missingBinaryMessage,
  normalizeMedium,
  type ArtworkAction,
  type DiscImageStudioPlan,
  type FilePosition,
  type SupportedMedium,
  type TargetPlatform,
} from "@/lib/optical/disc-image-studio";

export const OPTICAL_JOB_KIND = "disc-image-studio";

const IMAGE_NAME = /\.(png|jpe?g|gif|bmp)$/i;

export interface ArtworkJobInput {
  platform: TargetPlatform;
  action: ArtworkAction;
  medium: string;
  artworkPath: string;
  outputPath?: string;
  dataDir?: string;
  filePosition?: FilePosition;
  volumeLabel?: string;
  sectors?: number;
  totalSectors?: number;
  mock?: boolean;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (binary: string, args: string[]) => Promise<ProcessResult>;

export interface RunControl {
  hold?: Promise<void>;
  spawn?: SpawnFn;
  hostPlatform?: NodeJS.Platform;
  resolveBinary?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

interface ArtworkPayload {
  mock: boolean;
  plan: DiscImageStudioPlan;
  commandLine: string[];
  artworkPath: string;
  outputPath: string | null;
  releasesUrl: string;
  message?: string;
}

const controls = new Map<string, RunControl>();
let pumping = false;

export function opticalCapabilities(hostPlatform: NodeJS.Platform = process.platform) {
  return {
    hostPlatform,
    repoUrl: DISC_IMAGE_STUDIO_REPO,
    releasesUrl: DISC_IMAGE_STUDIO_RELEASES,
    license: DISC_IMAGE_STUDIO_LICENSE,
    media: [
      { id: "cd", label: "CD", sectors: CD_DEFAULT_SECTORS },
      { id: "dvd", label: "DVD", totalSectors: DVD_SL_TOTAL_SECTORS },
      { id: "bd-r", label: "BD-R, один слой", totalSectors: BD_R_SL_TOTAL_SECTORS },
    ],
    liveBurn: {
      windowsOnly: true,
      experimental: true,
      cliCommand: "burn-devices",
      writesDisc: false,
      note: "Живая запись IMAPI2 есть в графическом Windows-приложении и экспериментальна. CLI на macOS и Linux только собирает офлайн-образ. Команда burn-devices лишь перечисляет приводы и не пишет диск.",
    },
  };
}

export async function listArtworkCatalog(): Promise<
  { hostId: string; hostName: string; hostOs: string; torrent: string; path: string; name: string }[]
> {
  const dashboard = await getDashboard();
  const images: { hostId: string; hostName: string; hostOs: string; torrent: string; path: string; name: string }[] = [];
  for (const torrent of dashboard.torrents) {
    try {
      const detail = await getTorrentDetail(torrent.hostId, torrent.hash);
      for (const file of detail.files) {
        if (!IMAGE_NAME.test(file.name)) continue;
        images.push({
          hostId: torrent.hostId,
          hostName: torrent.hostName,
          hostOs: torrent.hostOs,
          torrent: torrent.name,
          path: file.absolutePath,
          name: file.name,
        });
      }
    } catch {
      continue;
    }
  }
  return images;
}

export async function enqueueArtworkJob(input: ArtworkJobInput, control?: RunControl): Promise<BackgroundJob> {
  if (!input.artworkPath?.trim()) {
    throw new OpticalError("validation", "Укажите файл рисунка: из каталога или путь к картинке.");
  }
  const medium = normalizeMedium(input.medium);
  const outputPath =
    input.action === "burn" ? input.outputPath?.trim() || undefined : input.outputPath?.trim() || defaultOutput(input, medium);
  const plan = buildDiscImageStudioPlan({ ...input, medium, outputPath });
  const key = [
    OPTICAL_JOB_KIND,
    plan.platform,
    plan.action,
    plan.medium,
    input.artworkPath.trim(),
    input.dataDir?.trim() || "",
  ].join("\0");
  const now = new Date().toISOString();
  const payload: ArtworkPayload = {
    mock: input.mock === true,
    plan,
    commandLine: commandLine(plan),
    artworkPath: input.artworkPath.trim(),
    outputPath: outputPath ?? null,
    releasesUrl: DISC_IMAGE_STUDIO_RELEASES,
    message: "В очереди",
  };
  const job: BackgroundJob = {
    id: `job-${randomUUID()}`,
    kind: OPTICAL_JOB_KIND,
    status: "queued",
    phase: "в очереди",
    percent: 0,
    currentFile: payload.artworkPath,
    bytesDone: null,
    bytesTotal: null,
    title: jobTitle(plan, input.artworkPath),
    error: null,
    mock: input.mock === true,
    hardware: false,
    idempotencyKey: key,
    claimedBy: null,
    createdAt: now,
    updatedAt: now,
    payload: payload as unknown as Record<string, unknown>,
  };
  const previous = controls.get(key);
  if (control) controls.set(key, control);
  const outcome = await mutateJobs((jobs) => {
    const existing = jobs.find((item) => item.idempotencyKey === key && ACTIVE_JOB.has(item.status));
    if (existing) return { job: existing, created: false };
    jobs.push(job);
    return { job, created: true };
  });
  if (!outcome.created) {
    if (previous) controls.set(key, previous);
    else controls.delete(key);
    return outcome.job;
  }
  setTimeout(() => {
    void pumpDiscJobs();
  }, 0);
  return outcome.job;
}

export async function listOpticalJobs(): Promise<BackgroundJob[]> {
  const jobs = await readJobs();
  return jobs.filter((job) => job.kind === OPTICAL_JOB_KIND).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function presentOpticalJob(job: BackgroundJob) {
  const payload = job.payload as ArtworkPayload;
  return {
    ...job,
    state: job.status,
    progress: job.percent,
    message: payload.message || job.phase,
  };
}

export async function resolveDiscImageStudioBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.DISC_IMAGE_STUDIO_BIN?.trim();
  if (configured) return (await isExecutable(configured)) ? configured : null;
  const names =
    process.platform === "win32"
      ? ["DiscImageStudio.exe", "disc-image-studio.exe", "disc-image-studio"]
      : ["disc-image-studio"];
  const entries = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function waitForJob(id: string, timeoutMs = 3000): Promise<BackgroundJob> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(id);
    if (job && (job.status === "done" || job.status === "error")) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const last = await getJob(id);
  if (!last) throw new Error("Задача пропала из очереди.");
  return last;
}

async function pumpDiscJobs(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const claimed = await mutateJobs((jobs) => {
        const next = jobs
          .filter((job) => job.kind === OPTICAL_JOB_KIND && job.status === "queued")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) return null;
        next.status = "running";
        next.claimedBy = "disc-image-studio";
        next.updatedAt = new Date().toISOString();
        return next;
      });
      if (!claimed) return;
      try {
        await executeClaimed(claimed);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "Задача остановилась с ошибкой.";
        await mutateJobs((jobs) => {
          const job = jobs.find((item) => item.id === claimed.id);
          if (!job || job.status === "done") return;
          job.status = "error";
          job.error = message;
          job.phase = "ошибка";
          job.hardware = false;
          job.updatedAt = new Date().toISOString();
          job.payload = { ...job.payload, message };
        });
      }
    }
  } finally {
    pumping = false;
  }
}

async function executeClaimed(job: BackgroundJob): Promise<void> {
  const payload = job.payload as unknown as ArtworkPayload;
  const control = controls.get(job.idempotencyKey);
  if (payload.mock) {
    await touch(job.id, { percent: 20, phase: "макет", mock: true, message: "Макет очереди: процесс DiscImageStudio не запускался." });
    if (control?.hold) await control.hold;
    await finish(job.id, mockDoneMessage(payload.plan), true);
    return;
  }
  const resolve = control?.resolveBinary ?? (() => resolveDiscImageStudioBinary(control?.env));
  const binary = await resolve();
  if (!binary) throw new OpticalError("tool_not_found", missingBinaryMessage());
  const hostPlatform = control?.hostPlatform ?? process.platform;
  if (payload.plan.action === "burn" && hostPlatform !== "win32") {
    throw new OpticalError(
      "validation",
      "Живая запись через IMAPI2 доступна только когда Склад запущен на Windows. Команда на привод не отправлялась. Диск не записан.",
    );
  }
  await touch(job.id, {
    percent: 35,
    phase: payload.plan.imapiProbe ? "опрос IMAPI2" : "сборка образа",
    message: payload.plan.imapiProbe
      ? "Запущена команда burn-devices: список приводов IMAPI2, без записи."
      : "Сборка офлайн-образа через CLI DiscImageStudio.",
  });
  const spawnProcess = control?.spawn ?? defaultSpawn;
  let result: ProcessResult;
  try {
    result = await spawnProcess(binary, payload.plan.args);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new OpticalError("tool_not_found", missingBinaryMessage());
    throw error;
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `код ${result.code}`).trim().slice(0, 800);
    throw new OpticalError("tool_not_found", `DiscImageStudio завершился с кодом ${result.code}. ${detail}`.trim());
  }
  await finish(job.id, exitZeroMessage(payload.plan, result.stdout), false);
}

async function touch(id: string, patch: { percent?: number; phase?: string; mock?: boolean; message?: string }): Promise<void> {
  await mutateJobs((jobs) => {
    const job = jobs.find((item) => item.id === id);
    if (!job) return;
    if (patch.percent !== undefined) job.percent = patch.percent;
    if (patch.phase) job.phase = patch.phase;
    if (patch.mock !== undefined) job.mock = patch.mock;
    job.hardware = false;
    job.updatedAt = new Date().toISOString();
    if (patch.message) job.payload = { ...job.payload, message: patch.message };
  });
}

async function finish(id: string, message: string, mock: boolean): Promise<void> {
  await mutateJobs((jobs) => {
    const job = jobs.find((item) => item.id === id);
    if (!job) return;
    job.status = "done";
    job.percent = 100;
    job.phase = message;
    job.error = null;
    job.mock = mock;
    job.hardware = false;
    job.updatedAt = new Date().toISOString();
    job.payload = { ...job.payload, message };
  });
}

function mockDoneMessage(plan: DiscImageStudioPlan): string {
  if (plan.imapiProbe) {
    return "Макет очереди (mock: true). Команда burn-devices не запускалась. Диск не записан и образ на носителе не создавался.";
  }
  return "Макет очереди (mock: true). Процесс DiscImageStudio не запускался. Образ на носителе не создавался, диск не записан.";
}

function exitZeroMessage(plan: DiscImageStudioPlan, stdout: string): string {
  const tail = stdout.trim().slice(-400);
  if (plan.imapiProbe) {
    return `Команда burn-devices завершилась с кодом 0. Это перечень приводов IMAPI2, не живая запись. Диск не записан.${tail ? ` ${tail}` : ""}`;
  }
  return `CLI завершился с кодом 0. Это сборка офлайн-образа, не запись на привод и не проверка видимого рисунка. Диск не записан.${tail ? ` ${tail}` : ""}`;
}

function defaultSpawn(binary: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-8000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function jobTitle(plan: DiscImageStudioPlan, artwork: string): string {
  const name = artwork.replace(/\\/g, "/").split("/").pop() || artwork;
  if (plan.imapiProbe) return `IMAPI2, перечень приводов: ${name}`;
  const medium = plan.medium === "bd-r" ? "BD-R" : plan.medium.toUpperCase();
  return `Офлайн-образ ${medium}: ${name}`;
}

function defaultOutput(input: ArtworkJobInput, medium: SupportedMedium): string {
  const extension = input.dataDir?.trim() || medium !== "cd" ? ".iso" : ".wav";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dataDir(), "optical-output", `surface-${medium}-${stamp}${extension}`);
}

function toProgressSnapshot(job: BackgroundJob): JobSnapshot {
  const payload = job.payload as unknown as ArtworkPayload;
  const status: JobStatus =
    job.status === "done" ? "completed" : job.status === "paused" ? "paused" : job.status === "error" ? "error" : job.status;
  const platform = payload.plan?.platform;
  return {
    id: `optical__${job.id}`,
    kind: "optical",
    title: job.title,
    status,
    progress: Math.max(0, Math.min(100, job.percent)) / 100,
    processedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 8_640_000,
    currentFile: job.currentFile,
    host: platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux",
    diskLabel: payload.plan?.medium ?? null,
    outputPath: payload.outputPath,
    error: job.error,
    capabilities: { pause: false, resume: false, cancel: false },
    pauseUnsupportedReason: "Эту сборку нельзя поставить на паузу.",
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
  };
}

registerJobSource({
  id: "disc-image-studio",
  list: async () => (await listOpticalJobs()).map(toProgressSnapshot),
});

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}
