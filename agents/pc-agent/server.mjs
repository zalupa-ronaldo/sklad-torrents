#!/usr/bin/env node
/**
 * Local Windows helper for Склад.
 * Default is mock mode: the same job protocol, no HandBrakeCLI and no compact.exe.
 * Set SKLAD_PC_AGENT_MOCK=0 only on the PC when those programs should actually run.
 * Bind address defaults to 127.0.0.1. There is no proxy and no VLESS.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceMock,
  assertWindowsPath,
  buildCompactArgv,
  buildHandBrakeArgv,
  confirmJob,
  httpError,
} from "./commands.mjs";
import { collectChannel, ensureLanForward } from "./channel-probe.mjs";
import { readAv1Status } from "./av1-status.mjs";
import { readLogTail, redactLine } from "./log-redact.mjs";
import {
  admitHeavy,
  DEFAULT_LOAD,
  effectiveParallel,
  fileLabel,
  classifyEncodeExit,
  handbrakeTempPath,
  normalizeProcessPriority,
  pauseHandBrake,
  rejectedVolume,
  releaseQueueHold,
  restoreJob,
  scheduleHolds,
} from "./load-policy.mjs";
import { consumeWatchLine, createGameService, watchGameProcesses } from "./game-mode.mjs";

// Lets /v1/index load the TypeScript NTFS indexer. Job routes do not use it.
try {
  register(new URL("./loader.mjs", import.meta.url), import.meta.url);
} catch {
  // Index requests report the loader failure. HandBrake and compact jobs still run.
}

const MOCK = process.env.SKLAD_PC_AGENT_MOCK !== "0";
const HOST = process.env.SKLAD_PC_AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4730);
const HANDBRAKE = process.env.HANDBRAKE_CLI || "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe";
const COMPACT = process.env.COMPACT_EXE || "C:\\Windows\\System32\\compact.exe";

const jobs = new Map();
const STATE = process.env.SKLAD_PC_AGENT_STATE || "";
const LOG = process.env.SKLAD_PC_AGENT_LOG || (process.env.SKLAD_PC_AGENT_LOG_DIR ? path.join(process.env.SKLAD_PC_AGENT_LOG_DIR, "agent.log") : "");
const STARTED = Date.now();
const VERSION = readVersion();
let queueUserPaused = false;
let gameActive = false;
loadState();
note(`queue restored paused=${[...jobs.values()].filter((job) => job.state === "paused").length} queued=${[...jobs.values()].filter((job) => job.state === "queued").length}`);

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => {
    const status = Number(error.status) || 500;
    send(res, status, { error: error.message || "Агент не смог выполнить запрос." });
  });
});

if (!MOCK && process.platform === "win32") {
  const keepForward = () => {
    ensureLanForward().then(
      (result) => {
        if (result !== "ok" && result !== "skipped") note(`channel ${result}`);
      },
      () => note("channel forward check failed"),
    );
  };
  setTimeout(keepForward, 2_000).unref();
  setInterval(keepForward, 60_000).unref();
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PORT;
  process.stdout.write(`sklad-pc-agent ${port}\n`);
  if (!MOCK && process.platform === "win32") void armGameWatch();
});

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "health") {
    send(res, 200, health());
    return;
  }
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "channel") {
    send(res, 200, await collectChannel());
    return;
  }
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "av1-status") {
    send(res, 200, await readAv1Status());
    return;
  }
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "logs") {
    const tail = Number(url.searchParams.get("tail") || 200);
    send(res, 200, { lines: readLogTail(LOG, tail) });
    return;
  }
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "jobs") {
    send(res, 200, { jobs: [...jobs.values()] });
    return;
  }
  if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "jobs") {
    const body = await readBody(req);
    const job = createJob(body);
    jobs.set(job.id, job);
    persist();
    send(res, 201, job);
    return;
  }
  if (req.method === "POST" && parts[0] === "v1" && parts[1] === "queue" && (parts[2] === "pause" || parts[2] === "resume")) {
    await readBody(req);
    if (parts[2] === "pause") queueUserPaused = true;
    else queueUserPaused = false;
    for (const job of jobs.values()) {
      if (parts[2] === "pause" && (job.state === "queued" || job.state === "running") && job.userPaused !== true) {
        const decision = pauseHandBrake({ processAlive: job.spawned === true && job.kind === "transcode" });
        job.queuePaused = true;
        if (decision.drainToBoundary) job.pauseRequested = true;
        else job.state = "paused";
      }
      if (parts[2] === "resume") {
        const released = releaseQueueHold(job);
        job.state = released.state;
        job.userPaused = released.userPaused;
        job.queuePaused = released.queuePaused;
        job.pauseRequested = false;
      }
    }
    persist();
    send(res, 200, { queueUserPaused, jobs: [...jobs.values()] });
    return;
  }
  if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "jobs") {
    const job = jobs.get(parts[2]);
    if (!job || !/^[a-zA-Z0-9-]{8,80}$/.test(parts[2])) {
      send(res, 404, { error: "Задание не найдено." });
      return;
    }
    if (req.method === "GET" && parts.length === 3) {
      send(res, 200, job);
      return;
    }
    if (req.method === "POST" && parts[3] === "pause") {
      await readBody(req);
      const decision = pauseHandBrake({ processAlive: job.spawned === true && job.kind === "transcode" });
      job.userPaused = true;
      job.pauseReason = "user";
      job.publishPartial = decision.publishPartial;
      if (decision.drainToBoundary) job.pauseRequested = true;
      else {
        job.state = "paused";
        job.pauseRequested = false;
      }
      persist();
      send(res, 200, job);
      return;
    }
    if (req.method === "POST" && parts[3] === "resume") {
      await readBody(req);
      if (job.userPaused !== true && job.state !== "paused") {
        throw httpError(409, "Продолжить можно только задачу на паузе.");
      }
      job.userPaused = false;
      job.pauseReason = null;
      job.pauseRequested = false;
      if (queueUserPaused) {
        job.queuePaused = true;
        job.state = "paused";
      } else {
        job.queuePaused = false;
        job.state = "queued";
      }
      persist();
      send(res, 200, job);
      return;
    }
    if (req.method === "POST" && parts[3] === "tick") {
      send(res, 200, tick(job));
      return;
    }
    if (req.method === "POST" && parts[3] === "confirm") {
      const body = await readBody(req);
      send(res, 200, confirmJob(job, body.deleteSource === true));
      return;
    }
  }
  if (parts[0] === "v1" && parts[1] === "game-mode") {
    const service = await gameService();
    if (req.method === "GET" && parts.length === 2) {
      send(res, 200, service.view());
      return;
    }
    if (req.method === "GET" && parts[2] === "events") {
      writeGameEvents(req, res, service);
      return;
    }
    if (req.method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      if (body.mode !== "on" && body.mode !== "off" && body.mode !== "auto") {
        send(res, 400, { error: "Нужен режим on, off или auto." });
        return;
      }
      send(res, 200, await service.sync({ mode: body.mode }));
      return;
    }
    if (req.method === "POST" && parts[2] === "library") {
      const body = await readBody(req);
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
      service.setLibrary(entries.filter((entry) => entry && typeof entry.name === "string").map((entry) => ({
        name: String(entry.name).slice(0, 200),
        exe: typeof entry.exe === "string" ? entry.exe.slice(0, 200) : undefined,
        root: typeof entry.root === "string" ? entry.root.slice(0, 300) : undefined,
        source: entry.source === "steam" ? "steam" : "sklad",
      })));
      send(res, 200, await service.sync({}));
      return;
    }
  }
  if (parts[0] === "v1" && parts[1] === "index") {
    const { handleFileIndex } = await import("./file-index-routes.mjs");
    await handleFileIndex(req, res, url);
    return;
  }
  if (parts[0] === "v1" && parts[1] === "optical") {
    const { handleOptical } = await import("./optical-routes.mjs");
    const result = await handleOptical(req, url, readBody);
    if (result) {
      send(res, result.status, result.body);
      return;
    }
  }
  send(res, 404, { error: "Не найдено." });
}

function health() {
  return {
    ok: true,
    protocol: 1,
    os: process.platform,
    mock: MOCK,
    role: "windows-pc",
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
    handbrakePath: HANDBRAKE,
    handbrakeFound: existsSync(HANDBRAKE),
    compactPath: COMPACT,
    compactFound: existsSync(COMPACT),
    note: "CompactGUI — оболочка для Windows. Сжатие делает compact.exe и только на NTFS. VLESS и прокси не используются.",
  };
}

function createJob(body) {
  if (!body || typeof body !== "object") throw httpError(400, "Пустое тело запроса.");
  for (const value of [body.inputPath, body.outputPath, body.sourcePath, body.destinationPath, body.folderPath]) {
    if (rejectedVolume(value)) throw httpError(400, "Этот том не используется.");
  }
  const kind = body.kind;
  const id = randomUUID();
  const base = {
    id,
    kind,
    title: String(body.title || kind || "Задание"),
    state: "queued",
    progress: 0,
    error: null,
    processedBytes: 0,
    currentFile: "",
    userPaused: false,
    queuePaused: false,
    pauseRequested: false,
    publishPartial: false,
    plannedArgv: [],
    outputMarker: null,
    inputPath: null,
    outputPath: null,
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
    spawned: false,
    mock: MOCK,
  };
  if (kind === "transcode") {
    const inputPath = assertWindowsPath(body.inputPath, "исходный файл");
    const outputPath = assertWindowsPath(body.outputPath, "файл результата");
    const binary = String(body.handbrakePath || HANDBRAKE);
    const preset = String(body.preset || "");
    const tempOutputPath = handbrakeTempPath(outputPath, id);
    return {
      ...base,
      inputPath,
      outputPath,
      currentFile: fileLabel(inputPath),
      tempOutputPath,
      plannedArgv: buildHandBrakeArgv({ binary, inputPath, outputPath, preset }),
      spawnArgv: buildHandBrakeArgv({ binary, inputPath, outputPath: tempOutputPath, preset }),
    };
  }
  if (kind === "compress") {
    const algorithm = String(body.algorithm || "");
    const binary = String(body.compactPath || COMPACT);
    const plannedArgv = buildCompactArgv({ binary, folder: body.folderPath, algorithm });
    return {
      ...base,
      algorithm,
      folderPath: plannedArgv[3].slice(3),
      plannedArgv,
    };
  }
  if (kind === "move") {
    const sourcePath = assertWindowsPath(body.sourcePath, "исходную папку");
    const destinationPath = assertWindowsPath(body.destinationPath, "папку назначения");
    if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
      throw httpError(400, "Папка назначения должна отличаться от исходной.");
    }
    return {
      ...base,
      sourcePath,
      destinationPath,
      deleteSource: false,
      plannedArgv: ["sklad-move", "--copy", sourcePath, "--dest", destinationPath, "--delete", "false"],
    };
  }
  throw httpError(400, "Неизвестный тип задания.");
}

let gameServicePromise;
function gameService() {
  if (!gameServicePromise) {
    gameServicePromise = (async () => {
      const logic = await import("../../src/lib/game-mode/session.ts");
      return createGameService({
        empty: logic.emptyHold,
        reduce: logic.reduceGame,
        viewOf: (state) => logic.gameView(state, MOCK ? "mock" : "ok"),
        mock: MOCK,
        jobs: () => [...jobs.values()].map((job) => ({
          id: job.id,
          kind: job.kind,
          pid: Number.isInteger(job.pid) ? job.pid : null,
          userPaused: job.userPaused === true,
        })),
        holdJobs: holdJobsForGame,
        apply: async (effects) => {
          await logic.applyEffects(effects, {
            pauseQueue() { holdJobsForGame(true); },
            resumeQueue() { holdJobsForGame(false); },
            async suspend(pid) { runSoft(logic.suspendArgv(pid, process.platform)); },
            async resume(pid) { runSoft(logic.continueArgv(pid, process.platform)); },
            async pauseTorrent() {},
            async resumeTorrent() {},
            isSteamPid() { return false; },
          });
          rememberPids(logic.nextHeldPids(readPids(), effects));
        },
      });
    })();
  }
  return gameServicePromise;
}

function holdJobsForGame(active) {
  gameActive = active === true;
  for (const job of jobs.values()) {
    if (job.kind !== "transcode" && job.kind !== "compress" && job.kind !== "nsz") continue;
    if (gameActive) {
      if (job.userPaused === true) continue;
      job.gameHeld = true;
    } else if (job.gameHeld === true) job.gameHeld = false;
  }
  persist();
}

function gameHoldPath() {
  return process.env.SKLAD_PC_AGENT_GAME_HOLD || path.join(tmpdir(), "sklad-pc-agent-game-hold.json");
}

function readPids() {
  try {
    const parsed = JSON.parse(readFileSync(gameHoldPath(), "utf8"));
    return Array.isArray(parsed.pids) ? parsed.pids.filter((pid) => Number.isInteger(pid) && pid > 0) : [];
  } catch {
    return [];
  }
}

function rememberPids(pids) {
  if (MOCK || process.platform !== "win32") return;
  const file = gameHoldPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pids }), { mode: 0o600 });
  renameSync(tmp, file);
}

function runSoft(argv) {
  if (MOCK || process.platform !== "win32" || !argv || argv.error || !argv.bin) return;
  if (argv.args.some((arg) => /KILL|taskkill|Stop-Process/i.test(String(arg)))) return;
  spawn(argv.bin, argv.args, { windowsHide: true, stdio: "ignore" });
}

function writeGameEvents(req, res, service) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (view) => {
    try { res.write(`data: ${JSON.stringify(view)}\n\n`); } catch { /* closed */ }
  };
  send(service.view());
  const stop = service.subscribe(send);
  req.on("close", stop);
}

async function armGameWatch() {
  const logic = await import("../../src/lib/game-mode/session.ts");
  for (const effect of logic.startupRecovery({ pids: readPids() })) {
    if (effect.op === "continue") runSoft(logic.continueArgv(effect.pid, process.platform));
  }
  rememberPids([]);
  const service = await gameService();
  try {
    const logic = await import("../../src/lib/game-mode/library.ts");
    const vdf = "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf";
    if (existsSync(vdf)) {
      const folders = logic.parseLibraryFolders(readFileSync(vdf, "utf8"));
      const manifests = [];
      for (const folder of folders) {
        const apps = path.win32.join(folder, "steamapps");
        let names = [];
        try { names = readdirSync(apps); } catch { continue; }
        for (const name of names) {
          if (!/^appmanifest_\d+\.acf$/i.test(name)) continue;
          try { manifests.push({ folder, text: readFileSync(path.win32.join(apps, name), "utf8") }); } catch { /* skip one */ }
        }
      }
      service.setLibrary(logic.steamLibraryEntries(folders, manifests));
    }
  } catch (error) {
    note(`game-mode library ${error instanceof Error ? error.message : "не прочитана"}`);
  }
  watchGameProcesses({
    spawn,
    script: fileURLToPath(new URL("./game-watch.ps1", import.meta.url)),
    onLine: (line) => { void consumeWatchLine(service, line); },
  });
}

function tick(job) {
  if (job.userPaused || job.gameHeld || job.state === "paused") return job;
  if (MOCK) return advanceMock(job);
  if (job.kind === "move") return advanceMock(job);
  if (job.spawned) return job;
  if (job.userPaused || job.gameHeld || job.state === "paused" || queueUserPaused || gameActive) return job;
  const load = readLoad();
  const running = [...jobs.values()].filter((item) => item.state === "running").length;
  if (!admitHeavy({
    running,
    maxParallel: effectiveParallel(load.maxParallel),
    userPaused: job.userPaused,
    queueUserPaused: queueUserPaused || gameActive,
    disturb: load.disturb === true,
    scheduleHold: scheduleHolds(load.schedule, new Date().getHours()),
  })) {
    return job;
  }
  const binary = (job.spawnArgv || job.plannedArgv)[0];
  if (!binary || !existsSync(binary)) {
    job.state = "failed";
    job.error = "Программа не найдена по указанному пути.";
    job.spawned = false;
    return job;
  }
  if (job.kind === "compress" && process.platform !== "win32") {
    job.state = "failed";
    job.error = "Только Windows, NTFS.";
    job.spawned = false;
    return job;
  }
  job.spawned = true;
  job.state = "running";
  job.pid = null;
  job.processPriority = normalizeProcessPriority(load.processPriority);
  const argv = job.spawnArgv || job.plannedArgv;
  const child = spawn(binary, argv.slice(1), { stdio: "ignore" });
  job.pid = child.pid ?? null;
  child.on("exit", (code) => {
    job.spawned = false;
    job.publishPartial = false;
    if (code === 0 && job.tempOutputPath && job.outputPath && job.tempOutputPath !== job.outputPath) {
      try {
        renameSync(job.tempOutputPath, job.outputPath);
      } catch {
        job.state = "failed";
        job.error = "Не удалось опубликовать готовый файл.";
        persist();
        return;
      }
    }
    if (code === 0) {
      job.error = null;
      job.state = job.pauseRequested || job.userPaused ? "paused" : "completed";
      if (job.state === "completed") job.progress = 1;
      job.pauseRequested = false;
    } else {
      const exit = classifyEncodeExit(code);
      if (job.userPaused || job.pauseRequested) {
        job.state = "paused";
        job.error = null;
      } else if (exit.handbrakeFallback) {
        job.state = "queued";
        job.error = null;
      } else {
        job.state = "failed";
        job.error = `Код ${code}`;
      }
      job.pauseRequested = false;
    }
    persist();
  });
  return job;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(httpError(400, "Слишком большой запрос."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "Не удалось разобрать запрос."));
      }
    });
    req.on("error", () => reject(httpError(400, "Не удалось прочитать запрос.")));
  });
}

function readVersion() {
  try {
    const file = new URL("../../package.json", import.meta.url);
    return JSON.parse(readFileSync(file, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function note(line) {
  if (!LOG) return;
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${redactLine(line)}\n`, { mode: 0o600 });
}

function loadState() {
  if (!STATE) return;
  try {
    const parsed = JSON.parse(readFileSync(STATE, "utf8"));
    queueUserPaused = parsed.queueUserPaused === true;
    const stored = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    for (const job of stored) {
      if (!job || typeof job.id !== "string") continue;
      const decision = restoreJob(job);
      job.state = decision.state;
      job.userPaused = decision.userPaused === true;
      job.queuePaused = decision.queuePaused === true;
      job.processedBytes = decision.processedBytes;
      job.currentFile = decision.currentFile;
      job.publishPartial = false;
      job.spawned = false;
      job.pid = null;
      job.gameHeld = false;
      job.pauseRequested = false;
      if (decision.clearError) job.error = null;
      if (decision.becameError === false && job.error && String(job.error).includes("перезапуском")) job.error = null;
      delete job.stepIndex;
      jobs.set(job.id, job);
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") queueUserPaused = false;
  }
}

function readLoad() {
  const file = process.env.SKLAD_PC_AGENT_LOAD || "";
  if (!file) return { ...DEFAULT_LOAD };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      maxParallel: Number.isFinite(parsed.maxParallel) ? parsed.maxParallel : DEFAULT_LOAD.maxParallel,
      processPriority: normalizeProcessPriority(parsed.processPriority),
      disturb: parsed.disturb === true,
      schedule: parsed.schedule || null,
    };
  } catch {
    return { ...DEFAULT_LOAD };
  }
}

function persist() {
  if (!STATE) return;
  mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, queueUserPaused, jobs: [...jobs.values()] }, null, 2), { mode: 0o600 });
  renameSync(tmp, STATE);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
