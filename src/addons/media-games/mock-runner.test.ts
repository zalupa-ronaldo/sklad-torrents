import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHandBrakeArgv } from "@/addons/media-games/handbrake";
import { getSpawnCount, resetSpawnCount } from "@/addons/media-games/local-runner";
import { advanceMockJob, createMockMover } from "@/addons/media-games/mock-runner";
import type { JobRecord } from "@/addons/media-games/types";

function transcodeJob(argv: string[], outputPath: string): JobRecord {
  return {
    id: "hb-1",
    kind: "transcode",
    hostId: "mac-local",
    state: "queued",
    progress: 0,
    title: "Interstellar",
    createdAt: 1,
    updatedAt: 1,
    error: null,
    runner: "mock",
    plannedArgv: argv,
    binaryFound: false,
    outputMarker: null,
    inputPath: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
    outputPath,
    presetId: "fast-1080p",
    presetLabel: "Быстрый 1080p",
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
  };
}

describe("mock runner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-mock-"));
    resetSpawnCount();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("progresses a transcode and records the HandBrake argv without spawning", async () => {
    const outputPath = "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4";
    const argv = buildHandBrakeArgv({
      binary: "/usr/local/bin/HandBrakeCLI",
      inputPath: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      outputPath,
      preset: "Fast 1080p30",
    });
    let step = await advanceMockJob(transcodeJob(argv, outputPath), 2);
    expect(step.job.state).toBe("running");
    expect(step.job.progress).toBeGreaterThan(0);
    expect(step.job.progress).toBeLessThan(1);
    expect(step.job.spawned).toBe(false);
    step = await advanceMockJob(step.job, 3);
    expect(step.job.state).toBe("running");
    expect(step.job.progress).toBeGreaterThan(0.34);
    step = await advanceMockJob(step.job, 4);
    expect(step.job.state).toBe("completed");
    expect(step.job.progress).toBe(1);
    expect(step.job.outputMarker).toBe(`mock-output:${outputPath}`);
    expect(step.job.plannedArgv).toEqual(argv);
    expect(step.job.spawned).toBe(false);
    expect(getSpawnCount()).toBe(0);
  });

  it("does not delete a real folder when the mock mover is told to", async () => {
    const folder = path.join(dir, "Hades");
    const file = path.join(folder, "game.bin");
    await import("node:fs/promises").then((fs) => fs.mkdir(folder, { recursive: true }));
    await writeFile(file, "keep");
    await createMockMover().deleteSource(folder);
    await expect(import("node:fs/promises").then((fs) => fs.access(file))).resolves.toBeUndefined();
    expect(getSpawnCount()).toBe(0);
  });
});
