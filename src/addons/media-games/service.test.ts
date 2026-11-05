import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultToolsConfig } from "@/addons/media-games/defaults";
import { ToolsError } from "@/addons/media-games/errors";
import { buildHandBrakeArgv } from "@/addons/media-games/handbrake";
import { getSpawnCount, resetSpawnCount } from "@/addons/media-games/local-runner";
import {
  confirmMove,
  enqueueCompress,
  enqueueMove,
  enqueueTranscode,
  getToolsSnapshot,
  saveToolsConfig,
} from "@/addons/media-games/service";

describe("media job service", () => {
  let dir: string;
  const agents: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-tools-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetSpawnCount();
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.kill();
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("queues a mock transcode, shows progress, and writes the argv marker", async () => {
    const inputPath = "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv";
    const outputPath = "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4";
    const job = await enqueueTranscode({
      hostId: "mac-local",
      inputPath,
      outputPath,
      presetId: "fast-1080p",
    });
    expect(job.runner).toBe("mock");
    expect(job.state).toBe("queued");
    expect(job.spawned).toBe(false);
    expect(job.plannedArgv).toEqual(
      buildHandBrakeArgv({
        binary: "/usr/local/bin/HandBrakeCLI",
        inputPath,
        outputPath,
        preset: "Fast 1080p30",
      }),
    );
    let current = job;
    for (let step = 0; step < 5 && current.state !== "completed"; step += 1) {
      const snapshot = await getToolsSnapshot();
      current = snapshot.jobs.find((item) => item.id === job.id) ?? current;
    }
    expect(current.state).toBe("completed");
    expect(current.outputMarker).toBe(`mock-output:${outputPath}`);
    expect(current.spawned).toBe(false);
    const marker = await readFile(path.join(dir, "mock-markers", `${job.id}.txt`), "utf8");
    expect(marker).toContain("Fast 1080p30");
    expect(marker).toContain(inputPath);
    expect(marker).toContain(outputPath);
    expect(marker).toContain("spawned=false");
    expect(getSpawnCount()).toBe(0);
  });

  it("does not spawn HandBrake when demo mode is off but the binary is missing", async () => {
    const config = defaultToolsConfig();
    config.demoMode = false;
    await saveToolsConfig(config);
    const job = await enqueueTranscode({
      hostId: "mac-local",
      inputPath: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      outputPath: "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4",
      presetId: "compat",
    });
    expect(job.runner).toBe("local");
    expect(job.binaryFound).toBe(false);
    const snapshot = await getToolsSnapshot();
    const failed = snapshot.jobs.find((item) => item.id === job.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.spawned).toBe(false);
    expect(failed?.error).toMatch(/HandBrakeCLI/);
    expect(getSpawnCount()).toBe(0);
  });

  it("keeps the source until verify and confirm, then updates the library without deleting the mock folder", async () => {
    const source = path.join(dir, "game-src");
    const destination = path.join(dir, "game-dst");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "game.bin"), "keep");
    const job = await enqueueMove({
      hostId: "mac-local",
      name: "Hades",
      sourcePath: source,
      destinationPath: destination,
    });
    expect(job.deleteSource).toBe(false);
    expect(job.plannedArgv.at(-1)).toBe("false");
    await expect(confirmMove(job.id, true)).rejects.toThrow(/не проверен/);
    let current = job;
    for (let step = 0; step < 6 && current.state !== "awaiting-confirm"; step += 1) {
      const snapshot = await getToolsSnapshot();
      current = snapshot.jobs.find((item) => item.id === job.id) ?? current;
      expect(current.deleteSource).toBe(false);
      expect(current.sourceDeleted).toBe(false);
    }
    expect(current.state).toBe("awaiting-confirm");
    expect(current.verified).toBe(true);
    const waiting = await getToolsSnapshot();
    expect(waiting.library[0]).toMatchObject({
      name: "Hades",
      oldPath: source,
      newPath: destination,
      status: "verified",
    });
    await access(path.join(source, "game.bin"));
    const done = await confirmMove(job.id, true);
    expect(done.deleteSource).toBe(true);
    expect(done.sourceDeleted).toBe(true);
    const after = await getToolsSnapshot();
    expect(after.library[0]?.status).toBe("moved");
    await access(path.join(source, "game.bin"));
    expect(getSpawnCount()).toBe(0);
  });

  it("refuses to compact an APFS path", async () => {
    await expect(
      enqueueCompress({
        hostId: "mac-local",
        folderPath: "/Volumes/vault/Games/Title",
        algorithm: "LZX",
      }),
    ).rejects.toThrow(ToolsError);
    await expect(
      enqueueCompress({
        hostId: "mac-local",
        folderPath: "/Volumes/vault",
        algorithm: "XPRESS8K",
      }),
    ).rejects.toThrow(/NTFS/);
  });

  it("talks to the PC agent in mock mode and still does not spawn HandBrake", async () => {
    const port = await startAgent();
    const config = defaultToolsConfig();
    config.demoMode = false;
    config.hosts = config.hosts.map((host) =>
      host.id === "pc-agent" ? { ...host, agentUrl: `http://127.0.0.1:${port}` } : host,
    );
    await saveToolsConfig(config);
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "compress", folderPath: "/Volumes/vault/Games/Title", algorithm: "LZX" }),
    });
    expect(rejected.status).toBe(400);
    const rejectedBody = (await rejected.json()) as { error: string };
    expect(rejectedBody.error).toMatch(/NTFS|APFS/);

    const inputPath = "D:\\Cinema\\Movie.mkv";
    const outputPath = "D:\\Cinema\\Movie.1080p.mp4";
    const expected = buildHandBrakeArgv({
      binary: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
      inputPath,
      outputPath,
      preset: "Fast 1080p30",
    });
    const job = await enqueueTranscode({
      hostId: "pc-agent",
      inputPath,
      outputPath,
      presetId: "fast-1080p",
    });
    expect(job.runner).toBe("pc-agent");
    expect(job.plannedArgv).toEqual(expected);
    let current = job;
    for (let step = 0; step < 8 && current.state !== "completed"; step += 1) {
      const snapshot = await getToolsSnapshot();
      current = snapshot.jobs.find((item) => item.id === job.id) ?? current;
    }
    expect(current.state).toBe("completed");
    expect(current.outputMarker).toBe(`mock-output:${outputPath}`);
    expect(current.plannedArgv).toEqual(expected);
    expect(current.spawned).toBe(false);
    expect(getSpawnCount()).toBe(0);

    const move = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "move",
        title: "Control",
        sourcePath: "D:\\Games\\Control",
        destinationPath: "C:\\Games\\Control",
      }),
    });
    const created = (await move.json()) as { id: string; deleteSource: boolean };
    expect(created.deleteSource).toBe(false);
    const early = await fetch(`http://127.0.0.1:${port}/v1/jobs/${created.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteSource: true }),
    });
    expect(early.status).toBe(400);
    const still = (await (await fetch(`http://127.0.0.1:${port}/v1/jobs/${created.id}`)).json()) as {
      deleteSource: boolean;
    };
    expect(still.deleteSource).toBe(false);
  });

  async function startAgent(): Promise<number> {
    const proc = spawn(process.execPath, [path.join(process.cwd(), "agents/pc-agent/server.mjs")], {
      env: {
        ...process.env,
        PORT: "0",
        SKLAD_PC_AGENT_MOCK: "1",
        SKLAD_PC_AGENT_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agents.push(proc);
    return new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`agent did not start\n${output}`)), 8000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /sklad-pc-agent (\d+)/.exec(output);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`agent exited ${code}\n${output}`));
      });
    });
  }
});
