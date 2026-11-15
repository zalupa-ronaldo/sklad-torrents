import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readLogTail, redactLine } from "../../../agents/pc-agent/log-redact.mjs";
import { autostartPlan, serviceScriptIncludes } from "../../../agents/pc-agent/service-plan.mjs";
import { applyRelease, rollbackRelease } from "../../../agents/pc-agent/update.mjs";

describe("pc-agent service", () => {
  it("redacts secrets and the excluded volume from logs", () => {
    const line = redactLine("token=abc123 path=Z:\\Cinema\\Movie.mkv and /mnt/z/Cinema");
    expect(line).not.toMatch(/abc123/);
    expect(line).not.toMatch(/Z:\\/);
    expect(line).not.toMatch(/\/mnt\/z/);
    expect(line).toContain("[redacted]");
  });

  it("plans boot autostart without deleting user files", () => {
    const plan = autostartPlan({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      supervisorPath: "C:\\sklad\\agents\\pc-agent\\windows\\supervisor.mjs",
      statePath: "C:\\ProgramData\\Sklad\\agent\\jobs.json",
      logDir: "C:\\ProgramData\\Sklad\\agent\\logs",
    });
    expect(plan.taskName).toBe("SkladPcAgent");
    expect(plan.trigger).toBe("AtStartup");
    expect(plan.deletesUserFiles).toBe(false);
    expect(() => autostartPlan({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      supervisorPath: "C:\\sklad\\agents\\pc-agent\\windows\\supervisor.mjs",
      statePath: "Z:\\agent\\jobs.json",
      logDir: "C:\\ProgramData\\Sklad\\agent\\logs",
    })).toThrow(/том/);
    const install = readFileSync(path.join(process.cwd(), "agents/pc-agent/windows/install-service.ps1"), "utf8");
    const uninstall = readFileSync(path.join(process.cwd(), "agents/pc-agent/windows/uninstall-service.ps1"), "utf8");
    expect(serviceScriptIncludes(install).startsAtBoot).toBe(true);
    expect(serviceScriptIncludes(install).keepsData).toBe(true);
    expect(serviceScriptIncludes(install).touchesExcludedVolume).toBe(false);
    expect(uninstall).not.toMatch(/Remove-Item/);
  });

  it("switches a release and rolls back without deleting data", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pc-agent-release-"));
    mkdirSync(path.join(root, "releases", "2"), { recursive: true });
    mkdirSync(path.join(root, "current"), { recursive: true });
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "releases", "2", "marker"), "two");
    writeFileSync(path.join(root, "current", "marker"), "one");
    writeFileSync(path.join(root, "data", "keep"), "user");
    expect(() => applyRelease({ root, version: "2", runningFrom: path.join(root, "current") })).toThrow(/остановите службу/);
    applyRelease({ root, version: "2", runningFrom: path.join(root, "service") });
    expect(readFileSync(path.join(root, "current", "marker"), "utf8")).toBe("two");
    expect(readFileSync(path.join(root, "previous", "marker"), "utf8")).toBe("one");
    expect(readFileSync(path.join(root, "data", "keep"), "utf8")).toBe("user");
    rollbackRelease(root);
    expect(readFileSync(path.join(root, "current", "marker"), "utf8")).toBe("one");
    expect(readFileSync(path.join(root, "data", "keep"), "utf8")).toBe("user");
  });

  it("restarts a dead child and continues a paused queue from the saved bytes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-agent-supervisor-"));
    const entry = path.join(dir, "exit.mjs");
    writeFileSync(entry, "console.log('token=abc123');\nprocess.exit(1);\n");
    const logDir = path.join(dir, "logs");
    const supervisor = spawn(process.execPath, [path.join(process.cwd(), "agents/pc-agent/windows/supervisor.mjs")], {
      env: {
        ...process.env,
        SKLAD_PC_AGENT_ENTRY: entry,
        SKLAD_PC_AGENT_LOG_DIR: logDir,
        SKLAD_PC_AGENT_MAX_RESTARTS: "1",
        SKLAD_PC_AGENT_RESTART_MS: "30",
      },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("supervisor did not stop")), 8000);
      supervisor.on("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    const log = readFileSync(path.join(logDir, "agent.log"), "utf8");
    expect(log).not.toMatch(/abc123/);
    expect(log).toContain("[redacted]");
    expect(log).toContain("supervisor stopped");

    const state = path.join(dir, "jobs.json");
    const logFile = path.join(dir, "agent.log");
    writeFileSync(state, JSON.stringify({
      version: 1,
      queueUserPaused: false,
      jobs: [{
        id: "job-12345678",
        kind: "transcode",
        state: "running",
        processedBytes: 5000,
        currentFile: "Movie.mkv",
        inputPath: "D:\\Cinema\\Movie.mkv",
        error: "Передача прервана перезапуском Склада. По протоколу она не завершена.",
        userPaused: false,
      }, {
        id: "job-paused01",
        kind: "transcode",
        state: "paused",
        processedBytes: 4096,
        currentFile: "Other.mkv",
        userPaused: true,
        error: null,
      }],
    }));
    const agent = await startAgent(state, logFile);
    const health = await getJson(agent, "/v1/health");
    expect(health.version).toBe("0.1.0");
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0);
    const running = await getJson(agent, "/v1/jobs/job-12345678");
    expect(running.state).toBe("queued");
    expect(running.processedBytes).toBe(5000);
    expect(running.currentFile).toBe("Movie.mkv");
    expect(running.error).toBeNull();
    const paused = await getJson(agent, "/v1/jobs/job-paused01");
    expect(paused.state).toBe("paused");
    expect(paused.processedBytes).toBe(4096);
    const lines = await getJson(agent, "/v1/logs?tail=20");
    expect(lines.lines.join("\n")).toContain("queue restored");
    expect(readLogTail(logFile, 20).join("\n")).not.toMatch(/Z:\\/);
    await stopAgent(agent);
  });
});

type Agent = { port: number; proc: ReturnType<typeof spawn> };

function startAgent(state: string, logFile: string): Promise<Agent> {
  const proc = spawn(process.execPath, [path.join(process.cwd(), "agents/pc-agent/server.mjs")], {
    env: {
      ...process.env,
      PORT: "0",
      SKLAD_PC_AGENT_MOCK: "1",
      SKLAD_PC_AGENT_HOST: "127.0.0.1",
      SKLAD_PC_AGENT_STATE: state,
      SKLAD_PC_AGENT_LOG: logFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => reject(new Error(`agent did not start\n${output}`)), 8000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /sklad-pc-agent (\d+)/.exec(output);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ port: Number(match[1]), proc });
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`agent exited ${code}\n${output}`));
    });
  });
}

async function stopAgent(agent: Agent) {
  agent.proc.kill("SIGTERM");
  await new Promise((resolve) => agent.proc.once("exit", resolve));
}

async function getJson(agent: Agent, pathname: string) {
  const response = await fetch(`http://127.0.0.1:${agent.port}${pathname}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
