import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  admitHeavy,
  channelKeepsQueue,
  classifyEncodeExit,
  effectiveParallel,
  fileLabel,
  handbrakeTempPath,
  normalizeProcessPriority,
  pauseHandBrake,
  rejectedVolume,
  releaseQueueHold,
  restoreJob,
  scheduleHolds,
} from "../../../agents/pc-agent/load-policy.mjs";

describe("pc-agent load policy", () => {
  it("keeps a user pause across restart and does not publish a partial HandBrake file", () => {
    const paused = restoreJob({
      kind: "transcode",
      state: "paused",
      userPaused: true,
      processedBytes: 4096,
      currentFile: "Movie.mkv",
      inputPath: "D:\\Cinema\\Movie.mkv",
    });
    expect(paused.state).toBe("paused");
    expect(paused.processedBytes).toBe(4096);
    expect(paused.currentFile).toBe("Movie.mkv");
    expect(paused.callResume).toBe(false);
    expect(paused.publishPartial).toBe(false);
    expect(paused.deleteSource).toBe(false);
    expect(paused.becameError).toBe(false);
    expect(paused.stepIndex).toBeUndefined();

    const lost = restoreJob({
      kind: "transcode",
      state: "running",
      processedBytes: 4096,
      currentFile: "Movie.mkv",
      exitCode: 3221225477,
      error: "Передача прервана перезапуском Склада. По протоколу она не завершена.",
      stepIndex: 2,
    });
    expect(lost.state).toBe("queued");
    expect(lost.becameError).toBe(false);
    expect(lost.restartFailure).toBe(false);
    expect(lost.renameTemp).toBe(false);
    expect(lost.publishPartial).toBe(false);
    expect(lost.deleteSource).toBe(false);
    expect(lost.retryIncompleteFromStart).toBe(true);
    expect(lost.keepCompletedFiles).toBe(true);
    expect(lost.stepIndex).toBeUndefined();
    expect(lost.processedBytes).toBe(4096);

    const exit = classifyEncodeExit(3221225477);
    expect(exit.restartFailure).toBe(false);
    expect(exit.handbrakeFallback).toBe(true);
    expect(exit.publishPartial).toBe(false);
    expect(exit.deleteSource).toBe(false);

    expect(pauseHandBrake({ processAlive: true })).toMatchObject({
      drainToBoundary: true,
      publishPartial: false,
      deleteSource: false,
      stateAfterDrain: "paused",
    });
    expect(pauseHandBrake({ processAlive: false }).drainToBoundary).toBe(false);
    expect(channelKeepsQueue()).toEqual({ setPause: false, callResume: false, becameError: false });
    expect(releaseQueueHold({ userPaused: true, state: "paused" })).toMatchObject({
      state: "paused",
      userPaused: true,
    });
  });

  it("caps priority and parallelism and rejects the excluded volume without echoing it", () => {
    expect(normalizeProcessPriority("high")).toBe("below-normal");
    expect(normalizeProcessPriority("realtime")).toBe("below-normal");
    expect(normalizeProcessPriority("idle")).toBe("idle");
    expect(normalizeProcessPriority("normal")).toBe("normal");
    expect(effectiveParallel(2, [1])).toBe(1);
    expect(scheduleHolds(null, 12)).toBe(false);
    expect(scheduleHolds({ startHour: 9, endHour: 9 }, 15)).toBe(false);
    expect(scheduleHolds({ startHour: 22, endHour: 6 }, 23)).toBe(false);
    expect(scheduleHolds({ startHour: 22, endHour: 6 }, 12)).toBe(true);
    expect(admitHeavy({ running: 1, maxParallel: 1, userPaused: false, queueUserPaused: false, disturb: false, scheduleHold: false })).toBe(false);
    expect(admitHeavy({ running: 0, maxParallel: 1, userPaused: true, queueUserPaused: false, disturb: false, scheduleHold: false })).toBe(false);
    expect(admitHeavy({ running: 0, maxParallel: 1, userPaused: false, queueUserPaused: false, disturb: true, scheduleHold: false })).toBe(false);

    const excluded = "Z:\\Cinema\\Movie.mkv";
    expect(rejectedVolume(excluded)).toBe(true);
    expect(rejectedVolume("/mnt/z/Cinema/Movie.mkv")).toBe(true);
    expect(rejectedVolume("D:\\Cinema\\Movie.mkv")).toBe(false);
    expect(fileLabel(excluded)).toBe("Movie.mkv");
    const temp = handbrakeTempPath("D:\\Cinema\\Movie.1080p.mp4", "abc");
    expect(temp.endsWith(".sklad-part-abc")).toBe(true);
    expect(temp.includes("Movie.1080p.mp4.sklad-part-abc")).toBe(true);
  });

  it("reloads a paused HandBrake job after the agent process is replaced", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-agent-"));
    const state = path.join(dir, "agent-jobs.json");
    const first = await startAgent(state);
    const created = await postJson(first, "/v1/jobs", {
      kind: "transcode",
      inputPath: "D:\\Cinema\\Movie.mkv",
      outputPath: "D:\\Cinema\\Movie.1080p.mp4",
      preset: "Fast 1080p30",
    });
    expect(created.currentFile).toBe("Movie.mkv");
    const paused = await postJson(first, `/v1/jobs/${created.id}/pause`, {});
    expect(paused.state).toBe("paused");
    expect(paused.userPaused).toBe(true);
    expect(paused.processedBytes).toBe(0);
    expect(paused.error).toBeNull();
    await stopAgent(first);

    const second = await startAgent(state);
    const restored = await getJson(second, `/v1/jobs/${created.id}`);
    expect(restored.state).toBe("paused");
    expect(restored.processedBytes).toBe(0);
    expect(restored.currentFile).toBe("Movie.mkv");
    expect(restored.error).toBeNull();
    expect(restored.stepIndex).toBeUndefined();
    expect(restored.userPaused).toBe(true);

    const queued = await postJson(second, "/v1/jobs", {
      kind: "transcode",
      inputPath: "D:\\Cinema\\Other.mkv",
      outputPath: "D:\\Cinema\\Other.1080p.mp4",
      preset: "Fast 1080p30",
    });
    await postJson(second, "/v1/queue/pause", {});
    await postJson(second, "/v1/queue/resume", {});
    const userStill = await getJson(second, `/v1/jobs/${created.id}`);
    const held = await getJson(second, `/v1/jobs/${queued.id}`);
    expect(userStill.state).toBe("paused");
    expect(held.state).toBe("queued");

    const denied = await fetch(`http://127.0.0.1:${second.port}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "transcode",
        inputPath: "Z:\\Cinema\\Movie.mkv",
        outputPath: "D:\\Cinema\\Movie.1080p.mp4",
        preset: "Fast 1080p30",
      }),
    });
    const deniedBody = (await denied.json()) as { error: string };
    expect(denied.status).toBe(400);
    expect(deniedBody.error).not.toMatch(/Z:/);
    expect(readFileSync(state, "utf8")).not.toMatch(/Z:/);
    await stopAgent(second);
  });
});

type Agent = { port: number; proc: ReturnType<typeof spawn> };

function startAgent(state: string): Promise<Agent> {
  const proc = spawn(process.execPath, [path.join(process.cwd(), "agents/pc-agent/server.mjs")], {
    env: {
      ...process.env,
      PORT: "0",
      SKLAD_PC_AGENT_MOCK: "1",
      SKLAD_PC_AGENT_HOST: "127.0.0.1",
      SKLAD_PC_AGENT_STATE: state,
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

async function postJson(agent: Agent, pathname: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${agent.port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function getJson(agent: Agent, pathname: string) {
  const response = await fetch(`http://127.0.0.1:${agent.port}${pathname}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
