import { randomUUID } from "node:crypto";
import path from "node:path";

import { kindLabel } from "@/lib/content/labels";
import type { ContentKind, PostAction } from "@/lib/content/types";
import { dataFile, readJsonFile, writeJsonFile } from "@/lib/json-file";
import { compactLeaf, handbrakeLeaf, outputPath } from "@/lib/policies/resolve";
import type { JobSnapshot } from "@/lib/progress/types";
import type { HostOs } from "@/lib/qbittorrent/types";

import { INCOMING_FOLDER, folderKind, planPlacement, type PipelineStage } from "@/lib/scheduler/auto-plan";
import { isSkippedVolume, mightBeLocal } from "@/lib/scheduler/skipped-volume";

const VIDEO = new Set(["mkv", "mp4", "avi", "m4v", "webm", "mov", "ts", "m2ts"]);

export const STAGE_LABEL: Record<PipelineStage | "done", string> = {
  index: "Индекс",
  classify: "Тип по папкам",
  layout: "Раскладка",
  transfer: "Копия",
  compress: "Сжатие",
  verify: "Проверка",
  done: "Готово",
};

export interface PipelineEffects {
  requestIndex(diskId: string | null): Promise<string>;
  readDir(dir: string): Promise<string[]>;
  kindOf(filePath: string): Promise<"file" | "dir" | "missing">;
  copyChunk(source: string, dest: string, offset: number): Promise<{ offset: number; done: boolean; total: number }>;
  hashChunk(token: string, filePath: string, offset: number): Promise<{ offset: number; done: boolean; total: number; hex: string | null }>;
  nextCatalogTops(diskId: string, cursor: number): Promise<{ names: string[]; next: number; done: boolean }>;
  torrentFiles(hostId: string, hash: string): Promise<{ name: string; size: number }[]>;
  enqueueCompress(input: {
    action: "handbrake" | "compact";
    title: string;
    hostId: string;
    hash: string;
    source: string;
    output: string;
    videoFile: string | null;
  }): Promise<string>;
  context(): Promise<{ rules: import("@/lib/policies/types").PolicyRules; disks: import("@/lib/drives/types").CatalogDisk[] }>;
}

export interface PipelineSeed {
  trigger: "disk" | "torrent";
  key: string;
  title: string;
  hostId: string;
  hash: string;
  diskId: string | null;
  sourcePath: string;
  os: HostOs;
  name: string;
}

type RunStatus = "queued" | "running" | "deferred" | "done" | "skipped" | "error";

interface ListedFile {
  source: string;
  dest: string;
  offset: number;
  copied: boolean;
  sourceHex: string;
  destHex: string;
  hashAt: number;
  hashSide: "source" | "dest" | "done";
}

interface DirFrame {
  absolute: string;
  relative: string;
  names: string[];
  index: number;
}

interface PipelineRun {
  id: string;
  trigger: "disk" | "torrent";
  key: string;
  title: string;
  hostId: string;
  hash: string;
  diskId: string | null;
  sourcePath: string;
  os: HostOs;
  name: string;
  status: RunStatus;
  stage: PipelineStage | "done";
  kind: ContentKind | null;
  folder: string;
  destinationDir: string;
  copyRoot: string;
  postAction: PostAction;
  transfer: "skip" | "copy" | "wait";
  note: string;
  error: string | null;
  currentFile: string | null;
  progress: number;
  deletesSource: false;
  filesLoaded: boolean;
  files: { name: string; size: number }[];
  folderTypes: { name: string; kind: ContentKind }[];
  topCounts: Record<string, number>;
  scanCursor: number;
  foldersDone: boolean;
  incomingNames: string[];
  incomingCursor: number;
  listed: boolean;
  walk: DirFrame[];
  copyFiles: ListedFile[];
  copyIndex: number;
  videoFile: string | null;
  compressDone: boolean;
  missingLocal: boolean;
  updatedAt: number;
  createdAt: number;
}

export interface PipelineCard {
  id: string;
  trigger: "disk" | "torrent";
  title: string;
  status: RunStatus;
  stage: PipelineStage | "done";
  stageLabel: string;
  kind: ContentKind | null;
  kindLabel: string;
  folder: string;
  progress: number;
  currentFile: string | null;
  note: string;
  deletesSource: false;
}

export interface PipelineView {
  runs: PipelineCard[];
  queued: number;
  running: number;
  deletesSource: false;
}

type ScheduleFn = (task: () => Promise<void>) => Promise<void>;

interface Memory {
  runs: PipelineRun[];
  seen: string[];
  diskOnline: Record<string, boolean>;
  pumping: boolean;
  loaded: boolean;
}

const memory: Memory = { runs: [], seen: [], diskOnline: {}, pumping: false, loaded: false };
const pending: Array<() => Promise<void>> = [];
const idleWaiters: Array<() => void> = [];
let effectsOverride: PipelineEffects | null = null;
let resolvedEffects: PipelineEffects | null = null;
let schedule: ScheduleFn = (task) =>
  new Promise((resolve, reject) => {
    setImmediate(() => {
      task().then(resolve, reject);
    });
  });

export function setPipelineSchedulerForTests(mode: "manual" | "immediate"): void {
  pending.length = 0;
  if (mode === "manual") {
    schedule = (task) => {
      pending.push(task);
      return Promise.resolve();
    };
    return;
  }
  schedule = (task) =>
    new Promise((resolve, reject) => {
      setImmediate(() => {
        task().then(resolve, reject);
      });
    });
}

export function setPipelineEffectsForTests(next: PipelineEffects | null): void {
  effectsOverride = next;
  resolvedEffects = null;
}

export function resetAutoPipelineForTests(): void {
  memory.runs = [];
  memory.seen = [];
  memory.diskOnline = {};
  memory.pumping = false;
  memory.loaded = true;
  pending.length = 0;
  effectsOverride = null;
  resolvedEffects = null;
  setPipelineSchedulerForTests("manual");
}

export async function drainPipelineForTests(limit = 2000): Promise<number> {
  let steps = 0;
  while (pending.length > 0 && steps < limit) {
    const task = pending.shift();
    if (!task) break;
    await task();
    steps += 1;
  }
  return steps;
}

export function whenPipelineIdle(): Promise<void> {
  if (!memory.pumping && pending.length === 0 && !hasRunnable()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export function rememberedDiskOnline(): Record<string, boolean> {
  return memory.diskOnline;
}

export function rememberDiskOnline(next: Record<string, boolean>): void {
  memory.diskOnline = next;
}

export function rememberedKeys(): string[] {
  return memory.seen;
}

export function rememberKey(key: string): void {
  if (!memory.seen.includes(key)) memory.seen.push(key);
}

export function resumeDeferredRuns(now = Date.now()): number {
  let resumed = 0;
  for (const run of memory.runs) {
    if (run.status !== "deferred") continue;
    const local = mightBeLocal(run.sourcePath);
    const due = now - run.updatedAt >= 60_000;
    if (!local) continue;
    if (run.missingLocal && !due) continue;
    if (run.transfer === "wait" && !due) continue;
    run.status = "queued";
    run.stage = "layout";
    run.foldersDone = run.trigger === "disk" ? run.foldersDone : false;
    resumed += 1;
  }
  if (resumed > 0) kick();
  return resumed;
}

export function enqueuePipelineRun(seed: PipelineSeed): PipelineRun | null {
  const active = memory.runs.find((run) => run.key === seed.key && (run.status === "queued" || run.status === "running" || run.status === "deferred"));
  if (active) return active;
  if (seed.trigger !== "disk" && memory.seen.includes(seed.key)) {
    return memory.runs.find((run) => run.key === seed.key) ?? null;
  }
  if (!memory.seen.includes(seed.key)) memory.seen.push(seed.key);
  const skipped = isSkippedVolume(seed.sourcePath);
  const now = Date.now();
  const run: PipelineRun = {
    id: randomUUID(),
    trigger: seed.trigger,
    key: seed.key,
    title: skipped ? "Диск Z:" : seed.title.slice(0, 180),
    hostId: seed.hostId,
    hash: seed.hash,
    diskId: seed.diskId,
    sourcePath: skipped ? "" : seed.sourcePath,
    os: seed.os,
    name: skipped ? "" : seed.name,
    status: skipped ? "skipped" : "queued",
    stage: skipped ? "done" : "index",
    kind: null,
    folder: "",
    destinationDir: "",
    copyRoot: "",
    postAction: "none",
    transfer: "skip",
    note: skipped ? "Диск Z: пропущен." : "В очереди",
    error: null,
    currentFile: null,
    progress: skipped ? 1 : 0,
    deletesSource: false,
    filesLoaded: false,
    files: [],
    folderTypes: [],
    topCounts: {},
    scanCursor: 0,
    foldersDone: false,
    incomingNames: [],
    incomingCursor: 0,
    listed: false,
    walk: [],
    copyFiles: [],
    copyIndex: 0,
    videoFile: null,
    compressDone: false,
    missingLocal: false,
    updatedAt: now,
    createdAt: now,
  };
  memory.runs.push(run);
  trim();
  if (!skipped) kick();
  return run;
}

export async function pipelineView(): Promise<PipelineView> {
  await ensureLoaded();
  return toView();
}

export function pipelineJobSnapshots(): JobSnapshot[] {
  return memory.runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "deferred").map(toSnapshot);
}

export async function drainPipelineStepForTests(): Promise<number> {
  return drainPipelineForTests();
}

async function ensureLoaded(): Promise<void> {
  if (memory.loaded) return;
  memory.loaded = true;
  const file = await readJsonFile<{ runs?: PipelineRun[]; seen?: string[]; diskOnline?: Record<string, boolean> }>(dataFile("auto-pipeline.json"), {});
  memory.runs = Array.isArray(file.runs) ? file.runs.filter(isRun).map(normalizeRun) : [];
  memory.seen = Array.isArray(file.seen) ? file.seen.filter((item) => typeof item === "string") : [];
  memory.diskOnline = file.diskOnline && typeof file.diskOnline === "object" ? file.diskOnline : {};
  if (hasRunnable()) kick();
}

function kick(): void {
  if (memory.pumping) return;
  memory.pumping = true;
  void schedule(async () => {
    try {
      await stepOnce();
    } catch (error) {
      const run = memory.runs.find((item) => item.status === "running");
      if (run) fail(run, error);
    } finally {
      memory.pumping = false;
      if (hasRunnable()) kick();
      else wake();
    }
  }).catch(() => {
    memory.pumping = false;
  });
}

async function stepOnce(): Promise<void> {
  const run = memory.runs.find((item) => item.status === "queued" || item.status === "running");
  if (!run) return;
  const stageBefore = run.stage;
  run.status = "running";
  await step(run);
  run.updatedAt = Date.now();
  run.progress = progressOf(run);
  const statusNow = run.status as RunStatus;
  if (run.stage !== stageBefore || statusNow !== "running") await saveRuns();
}

async function step(run: PipelineRun): Promise<void> {
  if (isSkippedVolume(run.sourcePath)) {
    run.status = "skipped";
    run.stage = "done";
    run.note = "Диск Z: пропущен.";
    run.sourcePath = "";
    return;
  }
  const effects = await fx();
  if (run.stage === "index") {
    run.note = await effects.requestIndex(run.diskId);
    run.stage = "classify";
    return;
  }
  if (run.stage === "classify") {
    await classifyStep(run, effects);
    return;
  }
  if (run.stage === "layout") {
    await layoutStep(run, effects);
    return;
  }
  if (run.stage === "transfer") {
    await transferStep(run, effects);
    return;
  }
  if (run.stage === "compress") {
    await compressStep(run, effects);
    return;
  }
  if (run.stage === "verify") {
    await verifyStep(run, effects);
    return;
  }
  run.status = "done";
}

async function classifyStep(run: PipelineRun, effects: PipelineEffects): Promise<void> {
  if (run.trigger === "disk") {
    if (mightBeLocal(run.sourcePath) && (await effects.kindOf(run.sourcePath)) === "dir") {
      const names = await effects.readDir(run.sourcePath);
      run.folderTypes = names.slice(0, 40).map((name) => ({ name, kind: folderKind(run.sourcePath, name, run.os) }));
      run.foldersDone = true;
      run.stage = "layout";
      run.note = run.folderTypes.length > 0 ? "Тип по верхним папкам диска." : "На диске нет папок верхнего уровня.";
      return;
    }
    const batch = await effects.nextCatalogTops(run.diskId ?? "", run.scanCursor);
    for (const name of batch.names) run.topCounts[name] = (run.topCounts[name] ?? 0) + 1;
    run.scanCursor = batch.next;
    if (!batch.done) return;
    const tops = Object.entries(run.topCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
      .slice(0, 40);
    run.folderTypes = tops.map(([name]) => ({ name, kind: folderKind(run.sourcePath, name, run.os) }));
    run.foldersDone = true;
    run.stage = "layout";
    run.note = run.folderTypes.length > 0 ? "Тип по папкам индекса." : "Индекс пока без папок. Типы появятся после сканирования.";
    run.topCounts = {};
    return;
  }

  if (!run.filesLoaded) {
    run.files = await effects.torrentFiles(run.hostId, run.hash);
    run.filesLoaded = true;
    return;
  }
  const placed = planPlacement({ ...(await placementInput(run, effects)) });
  if (placed.skippedVolume) {
    skipVolume(run);
    return;
  }
  applyPlacement(run, placed);
  run.stage = "layout";
}

async function layoutStep(run: PipelineRun, effects: PipelineEffects): Promise<void> {
  if (run.trigger === "disk") {
    const incoming = run.folderTypes.find((folder) => INCOMING_FOLDER.test(folder.name));
    const summary = run.folderTypes.map((folder) => `${folder.name}: ${kindLabel(folder.kind, null)}`).join(", ");
    run.note = summary ? `Раскладка по папкам: ${summary}.` : "Раскладывать нечего: папок нет.";
    run.kind = incoming?.kind ?? run.folderTypes[0]?.kind ?? null;
    run.folder = incoming?.name ?? "";
    if (incoming && mightBeLocal(run.sourcePath)) {
      if (run.incomingNames.length === 0 && run.incomingCursor === 0) {
        run.incomingNames = await effects.readDir(path.join(run.sourcePath, incoming.name));
      }
      const child = run.incomingNames[run.incomingCursor];
      if (child) {
        run.incomingCursor += 1;
        const sourcePath = path.join(run.sourcePath, incoming.name, child);
        if (!isSkippedVolume(sourcePath)) {
          enqueuePipelineRun({
            trigger: "torrent",
            key: `disk-item:${run.diskId ?? run.sourcePath}:${child}`,
            title: child,
            hostId: run.hostId,
            hash: "",
            diskId: run.diskId,
            sourcePath,
            os: run.os,
            name: child,
          });
        }
        return;
      }
    }
    run.transfer = "skip";
    run.postAction = "none";
    run.stage = "transfer";
    if (incoming && !mightBeLocal(run.sourcePath)) {
      run.note = `${run.note} Входящая папка разложится на машине, где подключён диск. Оригинал не удаляется.`;
    } else {
      run.note = `${run.note} Уже лежащие папки не копируются.`;
    }
    return;
  }

  const placed = planPlacement(await placementInput(run, effects));
  if (placed.skippedVolume) {
    skipVolume(run);
    return;
  }
  applyPlacement(run, placed);
  run.stage = "transfer";
}

async function transferStep(run: PipelineRun, effects: PipelineEffects): Promise<void> {
  if (run.transfer === "skip") {
    run.stage = "compress";
    if (!run.note.includes("копир")) run.note = `${run.note} Копия не нужна.`.trim();
    return;
  }
  if (!mightBeLocal(run.sourcePath)) {
    defer(run, run.note || "Файла нет на этой машине. Копия подождёт. Оригинал не трогаем.");
    return;
  }
  if (run.transfer === "wait") {
    defer(run, run.note);
    return;
  }
  if (!mightBeLocal(run.copyRoot || run.destinationDir)) {
    defer(run, run.note || "Папка библиотеки на другой машине. Оригинал не удаляется.");
    return;
  }
  const found = await discoverOne(run, effects);
  if (found === "missing") {
    run.missingLocal = true;
    defer(run, "Файла нет на этой машине. Оригинал не трогаем.");
    return;
  }
  if (found === "more") return;
  const file = run.copyFiles.find((item) => !item.copied);
  if (!file) {
    run.stage = "compress";
    run.note = "Копия готова. Исходник на месте.";
    return;
  }
  if (path.resolve(file.dest).startsWith(path.resolve(file.source) + path.sep)) {
    file.copied = true;
    run.note = "Назначение внутри исходной папки. Этот файл пропущен, исходник не трогаем.";
    return;
  }
  run.currentFile = path.basename(file.source);
  const chunk = await effects.copyChunk(file.source, file.dest, file.offset);
  file.offset = chunk.offset;
  if (chunk.done) {
    file.copied = true;
    if (VIDEO.has(extOf(file.dest)) && !run.videoFile) run.videoFile = file.dest;
  }
}

async function compressStep(run: PipelineRun, effects: PipelineEffects): Promise<void> {
  if (run.compressDone || run.postAction === "none" || run.trigger === "disk") {
    run.compressDone = true;
    run.stage = "verify";
    if (run.postAction === "none") run.note = `${strip(run.note)} Сжатие этому типу не нужно.`.trim();
    return;
  }
  const output = run.postAction === "handbrake"
    ? outputPath(run.os, run.destinationDir || run.copyRoot, handbrakeLeaf(run.name, (await effects.context()).rules[run.kind ?? "movie"].handbrake))
    : outputPath(run.os, run.destinationDir || run.copyRoot, compactLeaf(run.name));
  if (isSkippedVolume(output)) {
    skipVolume(run);
    return;
  }
  run.note = await effects.enqueueCompress({
    action: run.postAction,
    title: run.title,
    hostId: run.hostId,
    hash: run.hash,
    source: run.copyRoot || run.sourcePath,
    output,
    videoFile: run.videoFile,
  });
  run.compressDone = true;
  run.stage = "verify";
}

async function verifyStep(run: PipelineRun, effects: PipelineEffects): Promise<void> {
  const pendingFile = run.copyFiles.find((file) => file.copied && file.hashSide !== "done");
  if (!pendingFile) {
    const mismatch = run.copyFiles.find((file) => file.sourceHex && file.destHex && file.sourceHex !== file.destHex);
    if (mismatch) {
      run.status = "error";
      run.stage = "verify";
      run.error = "SHA-256 копии не совпал с исходником.";
      run.note = "Проверка не сошлась. Оригинал не удалён.";
      return;
    }
    run.status = "done";
    run.stage = "done";
    run.currentFile = null;
    if (run.copyFiles.length > 0) run.note = `${strip(run.note)} SHA-256 совпал.`.trim();
    else run.note = `${strip(run.note)} Проверять копию не пришлось.`.trim();
    return;
  }
  const side = pendingFile.hashSide;
  const target = side === "dest" ? pendingFile.dest : pendingFile.source;
  run.currentFile = path.basename(target);
  const hashed = await effects.hashChunk(`${run.id}:${pendingFile.source}:${side}`, target, pendingFile.hashAt);
  pendingFile.hashAt = hashed.offset;
  if (!hashed.done || !hashed.hex) return;
  if (side === "source") {
    pendingFile.sourceHex = hashed.hex;
    pendingFile.hashSide = "dest";
    pendingFile.hashAt = 0;
    return;
  }
  pendingFile.destHex = hashed.hex;
  pendingFile.hashSide = "done";
  pendingFile.hashAt = 0;
}

async function discoverOne(run: PipelineRun, effects: PipelineEffects): Promise<"more" | "ready" | "missing"> {
  if (run.listed && run.walk.length === 0) return "ready";
  if (!run.listed && run.walk.length === 0) {
    const kind = await effects.kindOf(run.sourcePath);
    if (kind === "missing") return "missing";
    if (kind === "file") {
      const dest = path.join(run.copyRoot || path.dirname(run.sourcePath), path.basename(run.sourcePath));
      run.copyFiles.push(blankFile(run.sourcePath, dest));
      run.listed = true;
      return "more";
    }
    const names = await effects.readDir(run.sourcePath);
    run.walk.push({ absolute: run.sourcePath, relative: "", names, index: 0 });
    run.listed = true;
    return "more";
  }
  const frame = run.walk[run.walk.length - 1];
  if (!frame) {
    run.listed = true;
    return "ready";
  }
  if (frame.index >= frame.names.length) {
    run.walk.pop();
    return "more";
  }
  const name = frame.names[frame.index] ?? "";
  frame.index += 1;
  const absolute = path.join(frame.absolute, name);
  const relative = frame.relative ? `${frame.relative}/${name}` : name;
  if (isSkippedVolume(absolute)) return "more";
  const kind = await effects.kindOf(absolute);
  if (kind === "dir") {
    const names = await effects.readDir(absolute);
    run.walk.push({ absolute, relative, names, index: 0 });
    return "more";
  }
  if (kind === "file") {
    const dest = path.join(run.copyRoot || run.destinationDir || path.dirname(run.sourcePath), relative);
    run.copyFiles.push(blankFile(absolute, dest));
  }
  return "more";
}

async function placementInput(run: PipelineRun, effects: PipelineEffects) {
  const { rules, disks } = await effects.context();
  return {
    name: run.name,
    sourcePath: run.sourcePath,
    os: run.os,
    files: run.files,
    rules,
    disks,
    hosts: [],
    hostId: run.hostId,
  };
}

function applyPlacement(run: PipelineRun, placed: ReturnType<typeof planPlacement>): void {
  run.kind = placed.kind;
  run.folder = placed.folder;
  run.destinationDir = placed.destinationDir;
  run.copyRoot = placed.copyRoot;
  run.postAction = placed.postAction;
  run.transfer = placed.transfer;
  run.note = placed.note;
}

function blankFile(source: string, dest: string): ListedFile {
  return { source, dest, offset: 0, copied: false, sourceHex: "", destHex: "", hashAt: 0, hashSide: "source" };
}

function defer(run: PipelineRun, note: string): void {
  run.status = "deferred";
  run.note = note;
  run.currentFile = null;
}

function skipVolume(run: PipelineRun): void {
  run.status = "skipped";
  run.stage = "done";
  run.note = "Диск Z: пропущен.";
  run.sourcePath = "";
  run.name = "";
  run.copyFiles = [];
}

function fail(run: PipelineRun, error: unknown): void {
  run.status = "error";
  run.error = error instanceof Error ? error.message : "Сбой авторежима";
  if (isSkippedVolume(run.error)) run.error = "Диск Z: пропущен.";
  run.note = "Оригинал не удалён.";
  run.deletesSource = false;
}

function progressOf(run: PipelineRun): number {
  if (run.status === "done" || run.status === "skipped") return 1;
  const order: Array<PipelineStage | "done"> = ["index", "classify", "layout", "transfer", "compress", "verify", "done"];
  const index = Math.max(0, order.indexOf(run.stage));
  return Math.min(0.99, index / (order.length - 1));
}

function hasRunnable(): boolean {
  return memory.runs.some((run) => run.status === "queued" || run.status === "running");
}

function terminal(status: RunStatus): boolean {
  return status === "done" || status === "skipped" || status === "error";
}

function trim(): void {
  const active = memory.runs.filter((run) => !terminal(run.status));
  const finished = memory.runs.filter((run) => terminal(run.status)).slice(-24);
  memory.runs = [...finished, ...active];
}

function wake(): void {
  const waiters = idleWaiters.splice(0);
  for (const waiter of waiters) waiter();
}

async function saveRuns(): Promise<void> {
  try {
    trim();
    await writeJsonFile(dataFile("auto-pipeline.json"), {
      runs: memory.runs,
      seen: memory.seen.slice(-500),
      diskOnline: memory.diskOnline,
    });
  } catch {
    // The queue still runs if the status file is busy.
  }
}

async function fx(): Promise<PipelineEffects> {
  if (effectsOverride) return effectsOverride;
  if (!resolvedEffects) {
    const mod = await import("@/lib/scheduler/auto-effects");
    resolvedEffects = mod.pipelineEffects;
  }
  return resolvedEffects;
}

function toView(): PipelineView {
  const runs = [...memory.runs].reverse().slice(0, 30).map(toCard);
  return {
    runs,
    queued: memory.runs.filter((run) => run.status === "queued" || run.status === "deferred").length,
    running: memory.runs.filter((run) => run.status === "running").length,
    deletesSource: false,
  };
}

function toCard(run: PipelineRun): PipelineCard {
  return {
    id: run.id,
    trigger: run.trigger,
    title: run.title,
    status: run.status,
    stage: run.stage,
    stageLabel: STAGE_LABEL[run.stage],
    kind: run.kind,
    kindLabel: run.kind ? kindLabel(run.kind, null) : "",
    folder: run.folder,
    progress: run.progress,
    currentFile: run.currentFile,
    note: run.note,
    deletesSource: false,
  };
}

function toSnapshot(run: PipelineRun): JobSnapshot {
  const kind = run.stage === "compress" && run.postAction === "handbrake"
    ? "transcode"
    : run.stage === "compress"
      ? "compact"
      : run.stage === "transfer"
        ? "copy"
        : "index";
  return {
    id: `pipeline-${run.id}`,
    kind,
    title: run.title,
    status: run.status === "running" ? "running" : run.status === "error" ? "error" : "queued",
    progress: run.progress,
    processedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 86_400,
    currentFile: run.currentFile ?? STAGE_LABEL[run.stage],
    host: run.hostId || null,
    diskLabel: run.folder || null,
    outputPath: null,
    error: run.error,
    capabilities: { pause: false, resume: false, cancel: false },
    pauseUnsupportedReason: "Авторежим идёт фоном и не блокирует панель.",
    updatedAt: run.updatedAt,
  };
}

function extOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function strip(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

function isRun(value: unknown): value is PipelineRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<PipelineRun>;
  return typeof run.id === "string" && typeof run.key === "string" && (run.trigger === "disk" || run.trigger === "torrent");
}

function normalizeRun(run: PipelineRun): PipelineRun {
  return {
    ...run,
    sourcePath: isSkippedVolume(run.sourcePath) ? "" : run.sourcePath,
    status: run.status === "running" ? "queued" : run.status,
    deletesSource: false,
    files: Array.isArray(run.files) ? run.files : [],
    folderTypes: Array.isArray(run.folderTypes) ? run.folderTypes : [],
    topCounts: {},
    incomingNames: Array.isArray(run.incomingNames) ? run.incomingNames : [],
    walk: [],
    copyFiles: Array.isArray(run.copyFiles) ? run.copyFiles : [],
    listed: false,
    copyIndex: 0,
    missingLocal: run.missingLocal === true,
  };
}
