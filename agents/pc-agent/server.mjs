#!/usr/bin/env node
/**
 * Local Windows helper for Склад.
 * Default is mock mode: the same job protocol, no HandBrakeCLI and no compact.exe.
 * Set SKLAD_PC_AGENT_MOCK=0 only on the PC when those programs should actually run.
 * Bind address defaults to 127.0.0.1. There is no proxy and no VLESS.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { register } from "node:module";

import {
  advanceMock,
  assertWindowsPath,
  buildCompactArgv,
  buildHandBrakeArgv,
  confirmJob,
  httpError,
} from "./commands.mjs";

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

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => {
    const status = Number(error.status) || 500;
    send(res, status, { error: error.message || "Агент не смог выполнить запрос." });
  });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PORT;
  process.stdout.write(`sklad-pc-agent ${port}\n`);
});

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "health") {
    send(res, 200, health());
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
    send(res, 201, job);
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
    handbrakePath: HANDBRAKE,
    handbrakeFound: existsSync(HANDBRAKE),
    compactPath: COMPACT,
    compactFound: existsSync(COMPACT),
    note: "CompactGUI — оболочка для Windows. Сжатие делает compact.exe и только на NTFS. VLESS и прокси не используются.",
  };
}

function createJob(body) {
  if (!body || typeof body !== "object") throw httpError(400, "Пустое тело запроса.");
  const kind = body.kind;
  const id = randomUUID();
  const base = {
    id,
    kind,
    title: String(body.title || kind || "Задание"),
    state: "queued",
    progress: 0,
    error: null,
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
    return { ...base, inputPath, outputPath, plannedArgv: buildHandBrakeArgv({ binary, inputPath, outputPath, preset }) };
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

function tick(job) {
  if (MOCK) return advanceMock(job);
  if (job.kind === "move") return advanceMock(job);
  if (job.spawned) return job;
  const binary = job.plannedArgv[0];
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
  const child = spawn(binary, job.plannedArgv.slice(1), { stdio: "ignore" });
  child.on("exit", (code) => {
    job.state = code === 0 ? "completed" : "failed";
    job.progress = code === 0 ? 1 : job.progress;
    job.error = code === 0 ? null : `Код ${code}`;
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

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
