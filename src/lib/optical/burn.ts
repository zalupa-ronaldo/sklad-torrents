import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";

import type { BackgroundJob } from "@/lib/jobs/types";
import { claimNext, getJob, insertIfIdle, patchJob, readJobs } from "@/lib/jobs/store";
import { shouldSuspendRunning } from "@/lib/optical/admission";
import { checkCapacity, treeBytes } from "@/lib/optical/capacity";
import { sourceDigest, type SourceReader } from "@/lib/optical/checksum";
import {
  admissionFor,
  clearOpticalLive,
  markOpticalLive,
  onOpticalQueueKick,
  pauseOpticalJob,
  opticalRunningCount,
  recoverOpticalAfterRestart,
  resumeOpticalJob,
  stepIndexOf,
} from "@/lib/optical/control";
import { assertOpticalPath } from "@/lib/optical/paths";
import { addBurnedDisc, listDiscs } from "@/lib/optical/catalog";
import { demoDrives } from "@/lib/optical/demo";
import { detectDrives, spawnExec } from "@/lib/optical/host-detect";
import { loadIndexedPaths } from "@/lib/optical/drive-catalog";
import { OpticalError } from "@/lib/optical/errors";
import { isAbsoluteFolder, planOptical } from "@/lib/optical/plan";
import { createMockRunner, createToolRunner, type ProcessRunner } from "@/lib/optical/runner";
import { searchBurnedFiles } from "@/lib/optical/search";
import { isDemoEnabled, writeDemoSetting } from "@/lib/optical/settings";
import type {
  BurnedDisc,
  DetectResult,
  IndexedPath,
  MediaKind,
  MediaProfile,
  OpticalAction,
  OpticalDrive,
  OpticalPayload,
  OpticalStep,
  SearchHit,
} from "@/lib/optical/media";

const OPTICAL_KINDS = ["optical.iso", "optical.burn", "optical.erase"] as const;
const WORKER_ID = "pc-agent";
const LOCAL_MAC_BURN = /\b(?:drutil|hdiutil)\s+burn\b/i;

let runnerOverride: ProcessRunner | null = null;
let sourceReader: SourceReader | null = null;
let pumpTail: Promise<void> = Promise.resolve();
let pumping = false;

export function setRunnerForTests(runner: ProcessRunner | null): void {
  runnerOverride = runner;
}

export function setSourceReaderForTests(reader: SourceReader | null): void {
  sourceReader = reader;
}

export function opticalIdle(): Promise<void> {
  return pumpTail;
}

export interface EnqueueInput {
  action: OpticalAction;
  profile?: MediaProfile | null;
  driveId?: string | null;
  files?: IndexedPath[];
  outputDir?: string | null;
  label?: string;
  locationNote?: string;
  eraseConfirmed?: boolean;
  demo?: boolean;
}

export interface OpticalJob extends Omit<BackgroundJob, "payload"> {
  payload: OpticalPayload;
}

function windowsReportedDrives(demo: boolean): Promise<DetectResult> {
  if (process.env.SKLAD_OPTICAL_AGENT === "offline") {
    return Promise.resolve({
      status: "no-drive",
      drives: [],
      detail: "Рекордер подключён к Windows-ПК. агент Windows недоступен",
    });
  }
  const mockAgent = process.env.SKLAD_OPTICAL_MOCK !== "0" && process.env.NODE_ENV !== "production";
  if (demo || mockAgent) {
    return Promise.resolve({
      status: demo ? "demo" : "ok",
      drives: demoDrives().map((drive) => ({ ...drive, demo })),
      detail: "Рекордер подключён к Windows-ПК. Список приводов сообщил агент Windows.",
    });
  }
  return detectDrives({ platform: "win32", demo: false, exec: spawnExec() });
}

export async function opticalSnapshot(): Promise<{
  demo: boolean;
  detection: DetectResult;
  files: IndexedPath[];
  fileSource: "drive-manager" | "demo";
  discs: BurnedDisc[];
}> {
  const demo = await isDemoEnabled();
  const [detection, indexed, discs] = await Promise.all([
    windowsReportedDrives(demo),
    loadIndexedPaths(),
    listDiscs(),
  ]);
  return { demo, detection, files: indexed.records, fileSource: indexed.source, discs };
}

export async function setDemoMode(enabled: boolean): Promise<boolean> {
  await writeDemoSetting(enabled);
  return isDemoEnabled();
}

export async function searchShelf(query: string): Promise<SearchHit[]> {
  const [discs, detection] = await Promise.all([
    listDiscs(),
    windowsReportedDrives(await isDemoEnabled()),
  ]);
  const drives = detection.status === "demo" ? [] : detection.drives;
  return searchBurnedFiles(discs, query, drives);
}

export async function enqueueOptical(input: EnqueueInput, deps?: { detect?: () => Promise<DetectResult> }): Promise<OpticalJob> {
  const demo = input.demo === true || (input.demo !== false && (await isDemoEnabled()));
  const action = input.action;
  if (action !== "iso" && action !== "burn" && action !== "erase") {
    throw new OpticalError("validation", "Неизвестное действие.");
  }
  const detect = deps?.detect ?? (() => windowsReportedDrives(demo));
  const detection = await detect();
  const drive = input.driveId ? detection.drives.find((item) => item.id === input.driveId) ?? null : null;
  if ((action === "burn" || action === "erase") && !drive) {
    throw new OpticalError("validation", "Выберите привод.");
  }
  const files = action === "erase" ? [] : normalizeFiles(input.files);
  if (action !== "erase" && files.length === 0) {
    throw new OpticalError("validation", "Выберите файлы или папку из каталога.");
  }
  const profile = input.profile ?? drive?.suggestedProfile ?? null;
  if (
    action !== "erase" &&
    profile !== "cd" &&
    profile !== "dvd-sl" &&
    profile !== "dvd-dl" &&
    profile !== "bd-sl" &&
    profile !== "bd-dl"
  ) {
    throw new OpticalError("validation", "Выберите профиль: CD, DVD, DVD DL, Blu-ray или Blu-ray DL.");
  }
  const totalBytes = treeBytes(files);
  if (action !== "erase" && profile) {
    const capacity = checkCapacity(totalBytes, profile);
    if (!capacity.ok) throw new OpticalError("validation", capacity.reason);
  }
  const label = (input.label || "").trim().slice(0, 80);
  const locationNote = (input.locationNote || "").trim().slice(0, 120);
  if (action === "burn" && !label) throw new OpticalError("validation", "Подпишите диск.");
  if (action === "burn" && !locationNote) throw new OpticalError("validation", "Укажите, где будет лежать диск.");
  const outputDir = (input.outputDir || "").trim();
  if (action !== "erase") {
    if (!isAbsoluteFolder(outputDir)) {
      throw new OpticalError("validation", "Укажите папку на диске, куда положить образ.");
    }
    assertOpticalPath(outputDir);
    if (!demo) {
      try {
        await access(outputDir);
      } catch {
        throw new OpticalError("validation", "Папка для образа не найдена.");
      }
    }
  }
  const eraseConfirmed = input.eraseConfirmed === true;
  if (action === "erase" && !eraseConfirmed) {
    throw new OpticalError("validation", "Стирание выключено, пока нет подтверждения.");
  }
  const media: MediaKind = drive?.media ?? "unknown";
  const platform = "win32" as const;
  const plan = planOptical({
    action,
    platform,
    media,
    eraseConfirmed,
    device: drive?.recorderId || drive?.device || "",
    driveIndex: drive?.driveIndex ?? null,
    files,
    outputDir: outputDir || "/",
    label: label || "disc",
  });
  if (action === "erase" && !plan.erase) {
    throw new OpticalError("validation", "Этот диск не перезаписываемый, стирать его нельзя.");
  }
  const runner = runnerFor(demo);
  const now = new Date().toISOString();
  const payload: OpticalPayload = {
    action,
    profile,
    driveId: drive?.id ?? null,
    driveName: drive?.name ?? null,
    device: drive?.device ?? null,
    platform,
    media,
    files,
    isoPath: plan.isoPath,
    outputDir: action === "erase" ? null : outputDir,
    label,
    locationNote,
    erase: plan.erase,
    eraseConfirmed,
    demo,
    volumeUuid: drive?.volumeUuid ?? null,
    host: "pc-agent",
    verifiedBy: null,
    verified: false,
    source: null,
    steps: plan.steps,
    totalBytes,
    stepIndex: 0,
    sourceSha256: null,
    pausedBy: null,
    processPriority: "below-normal",
  };
  const job: OpticalJob = {
    id: randomUUID(),
    kind: `optical.${action}`,
    status: "queued",
    phase: "ожидание",
    percent: 0,
    currentFile: files[0]?.name ?? null,
    bytesDone: 0,
    bytesTotal: totalBytes,
    title: jobTitle(action, label, drive),
    error: null,
    mock: runner.mock,
    hardware: false,
    idempotencyKey: idempotencyKey(action, drive?.id ?? null, files),
    host: "pc-agent",
    claimedBy: null,
    createdAt: now,
    updatedAt: now,
    payload,
  };
  const duplicate = await insertIfIdle(toStored(job));
  if (duplicate) {
    throw new OpticalError("conflict", "Такая запись уже в очереди: тот же набор файлов, тот же привод и тот же тип.");
  }
  schedulePump();
  return job;
}

export async function setJobPaused(id: string, paused: boolean): Promise<BackgroundJob> {
  return paused ? pauseOpticalJob(id) : resumeOpticalJob(id);
}

export async function listOpticalJobs(): Promise<BackgroundJob[]> {
  const jobs = await readJobs();
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function schedulePump(): void {
  pumpTail = pumpTail.then(() => pump());
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    await recoverOpticalAfterRestart();
    for (;;) {
      const decision = await admissionFor(await opticalRunningCount());
      if (!decision.start) break;
      const job = await claimNext(WORKER_ID, OPTICAL_KINDS);
      if (!job) break;
      await executeClaimed(job);
    }
  } finally {
    pumping = false;
  }
}

async function executeClaimed(claimed: BackgroundJob): Promise<void> {
  const payload = readPayload(claimed);
  const runner = runnerFor(payload.demo);
  markOpticalLive(claimed.id);
  try {
    const digest = await sourceDigest(payload.files, sourceReader ?? defaultSourceRead).catch((error: unknown) => {
      if (error instanceof OpticalError && error.code === "forbidden") throw error;
      return null;
    });
    if (digest) await patchJob(claimed.id, { payload: { sourceSha256: digest } });
    let verifyRan = 0;
    const verifyNeeded = payload.steps.filter((step) => step.phase === "проверка").length;
    const steps = payload.steps;
    for (let index = stepIndexOf(claimed); index < steps.length; index += 1) {
      const step = steps[index];
      const ready = await getJob(claimed.id);
      if (!ready || ready.status !== "running") return;
      const decision = await admissionFor(0);
      if (shouldSuspendRunning(decision)) {
        await patchJob(claimed.id, {
          status: "paused",
          claimedBy: null,
          error: null,
          payload: { pausedBy: decision.reason, stepIndex: index, processPriority: decision.processPriority },
        });
        return;
      }
      if (LOCAL_MAC_BURN.test(step.argv.join(" "))) {
        await failJob(claimed.id, "Mac не записывает диск локально.", runner.mock);
        return;
      }
      const percent = percentFor(step.phase);
      await patchJob(claimed.id, {
        status: "running",
        phase: step.phase,
        percent,
        currentFile: step.currentFile,
        bytesDone: Math.round(((payload.totalBytes || 0) * percent) / 100),
        bytesTotal: payload.totalBytes,
        payload: { stepIndex: index, processPriority: decision.processPriority },
      });
      let result;
      try {
        result = await runner.run({ argv: step.argv, phase: step.phase });
      } catch (error) {
        await failJob(claimed.id, error instanceof Error ? error.message : "Команда не запустилась.", runner.mock);
        return;
      }
      if (step.phase === "проверка") verifyRan += 1;
      if (result.code !== 0) {
        const detail = result.stderr.trim() || "Команда завершилась с ошибкой.";
        await failJob(claimed.id, detail, runner.mock);
        return;
      }
      const after = await getJob(claimed.id);
      if (!after || after.status !== "running") return;
      await patchJob(claimed.id, { payload: { stepIndex: index + 1 } });
    }
    const finished = await getJob(claimed.id);
    if (!finished || finished.status !== "running") return;
    const hadBurn = payload.steps.some((step) => step.phase === "запись");
    const verified =
      claimed.claimedBy === "pc-agent" &&
      payload.action === "burn" &&
      hadBurn &&
      verifyNeeded > 0 &&
      verifyRan === verifyNeeded;
    if (payload.action === "burn" && verified) {
      if (runner.mock && payload.demo) {
        await addBurnedDisc(discFrom(claimed.id, payload, "mock"));
      } else if (!runner.mock) {
        await addBurnedDisc(discFrom(claimed.id, payload, "tool"));
      }
    }
    await patchJob(claimed.id, {
      status: "done",
      phase: payload.steps.at(-1)?.phase ?? "проверка",
      percent: 100,
      bytesDone: payload.totalBytes,
      error: null,
      mock: runner.mock,
      hardware: !runner.mock && verified && payload.action === "burn",
      payload: {
        verified,
        verifiedBy: verified ? "pc-agent" : null,
        host: "pc-agent",
        source: runner.mock ? "mock" : "tool",
        erase: payload.erase,
      },
    });
  } catch (error) {
    await failJob(claimed.id, error instanceof Error ? error.message : "Задача остановилась.", runner.mock);
  } finally {
    clearOpticalLive(claimed.id);
  }
}

async function failJob(id: string, message: string, mock: boolean): Promise<void> {
  await patchJob(id, {
    status: "error",
    error: message,
    mock,
    hardware: false,
    payload: { verified: false, source: mock ? "mock" : null },
  });
}

async function defaultSourceRead(filePath: string): Promise<Uint8Array | null> {
  assertOpticalPath(filePath);
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return null;
    return new Uint8Array(await readFile(filePath));
  } catch {
    return null;
  }
}

function runnerFor(demo: boolean): ProcessRunner {
  if (runnerOverride) return runnerOverride;
  if (demo) {
    const delayMs = Number(process.env.SKLAD_OPTICAL_MOCK_MS || 700);
    return createMockRunner({ delayMs: Number.isFinite(delayMs) ? delayMs : 700 });
  }
  return createToolRunner();
}

function discFrom(jobId: string, payload: OpticalPayload, source: "mock" | "tool"): BurnedDisc {
  const profile = payload.profile ?? "dvd-sl";
  const readableId = payload.volumeUuid;
  return {
    id: readableId || randomUUID(),
    idOrigin: readableId ? "media" : "generated",
    hardwareSerial: null,
    label: payload.label || "Без подписи",
    locationNote: payload.locationNote,
    profile,
    media: payload.media,
    files: payload.files,
    source,
    jobId,
    createdAt: new Date().toISOString(),
    bytes: payload.totalBytes,
  };
}

function normalizeFiles(files: IndexedPath[] | undefined): IndexedPath[] {
  if (!Array.isArray(files)) return [];
  const records = files
    .filter((file) => file && typeof file.path === "string" && file.path.trim())
    .map((file) => ({
      diskLabel: String(file.diskLabel || "Диск").slice(0, 80),
      path: file.path.trim(),
      name: String(file.name || file.path.split(/[/\\]/).pop() || file.path).slice(0, 180),
      size: Number.isFinite(file.size) ? Math.max(0, file.size) : 0,
      kind: file.kind === "folder" ? ("folder" as const) : ("file" as const),
    }));
  for (const file of records) assertOpticalPath(file.path);
  return records;
}

function idempotencyKey(action: OpticalAction, driveId: string | null, files: IndexedPath[]): string {
  const paths = files.map((file) => file.path).sort().join("\n");
  return `optical:${action}:${driveId ?? "-"}:${paths}`;
}

function jobTitle(action: OpticalAction, label: string, drive: OpticalDrive | null): string {
  if (action === "iso") return `Образ ISO · ${label || "без подписи"}`;
  if (action === "erase") return `Стирание · ${drive?.name || "привод"}`;
  return `Запись · ${label || drive?.name || "диск"}`;
}

function percentFor(phase: OpticalStep["phase"]): number {
  if (phase === "образ") return 20;
  if (phase === "запись") return 60;
  return 90;
}

function readPayload(job: BackgroundJob): OpticalPayload {
  return job.payload as unknown as OpticalPayload;
}

function toStored(job: OpticalJob): BackgroundJob {
  return { ...job, payload: { ...job.payload } as unknown as Record<string, unknown> };
}

export function readOpticalPayload(job: BackgroundJob): OpticalPayload {
  return readPayload(job);
}

onOpticalQueueKick(() => {
  schedulePump();
});
