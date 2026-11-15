#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactLine } from "../log-redact.mjs";
import { rejectedVolume } from "../load-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.env.SKLAD_PC_AGENT_ENTRY || path.join(here, "..", "server.mjs");
const logDir = process.env.SKLAD_PC_AGENT_LOG_DIR || "";
const maxRestarts = Number(process.env.SKLAD_PC_AGENT_MAX_RESTARTS || 100);
const restartMs = Number(process.env.SKLAD_PC_AGENT_RESTART_MS || 1000);
const logFile = logDir ? path.join(logDir, "agent.log") : "";

if (rejectedVolume(entry) || rejectedVolume(logDir)) {
  process.stderr.write("Этот том не используется.\n");
  process.exit(1);
}

if (logDir) mkdirSync(logDir, { recursive: true });

let child = null;
let restarts = 0;
let stopping = false;

function note(line) {
  const text = redactLine(line);
  if (logFile) appendFileSync(logFile, `${text}\n`, { mode: 0o600 });
}

function start() {
  child = spawn(process.execPath, [entry], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onChunk = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line) note(line);
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("exit", (code) => {
    note(`child exit ${code ?? "signal"}`);
    child = null;
    if (stopping) {
      process.exit(0);
      return;
    }
    restarts += 1;
    if (restarts > maxRestarts) {
      note("supervisor stopped");
      process.exit(code || 1);
      return;
    }
    setTimeout(start, restartMs);
  });
}

function stop() {
  stopping = true;
  if (child) child.kill("SIGTERM");
  else process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
note("supervisor start");
start();
