import { describe, expect, it } from "vitest";

import {
  chunkGapMs,
  controlIndex,
  defaultIndexPolicy,
  disksToIndexJobs,
  jobProgress,
  jobTemplate,
  mergeIndexFiles,
  noteIndexChunk,
  queueProgress,
  quietActive,
  reopenAfterRestart,
  scheduleIndex,
  type IndexJob,
} from "@/addons/drives/index-session";
import type { DiskRecord } from "@/addons/drives/types";

function job(id: string, partial: Partial<IndexJob> = {}) {
  return jobTemplate({ id, label: id, ...partial });
}

describe("index load and pause", () => {
  it("runs the higher priority job and keeps the rest queued", () => {
    const policy = { ...defaultIndexPolicy(), parallelism: 1 };
    const scheduled = scheduleIndex(
      [job("low", { priority: 1, updatedAt: 1 }), job("high", { priority: 9, updatedAt: 2 })],
      policy,
      new Date("2026-11-15T12:00:00"),
    );
    expect(scheduled.find((item) => item.id === "high")?.status).toBe("running");
    expect(scheduled.find((item) => item.id === "low")?.status).toBe("queued");
  });

  it("does not resume a user pause when quiet ends, and does resume a quiet pause", () => {
    const user = job("user", { status: "paused", pauseReason: "user", checkpoint: { recordsDone: 4, recordsTotal: 10, mftOffset: 100, nextUsn: "9" } });
    const quietJob = job("quiet", { status: "paused", pauseReason: "quiet" });
    const policy = { ...defaultIndexPolicy(), quiet: false, quietHours: [] };
    const scheduled = scheduleIndex([user, quietJob], policy, new Date("2026-11-15T15:00:00"));
    expect(scheduled.find((item) => item.id === "user")).toMatchObject({ status: "paused", pauseReason: "user", checkpoint: { recordsDone: 4 } });
    expect(scheduled.find((item) => item.id === "quiet")?.status).toBe("running");
  });

  it("pauses a running index while quiet and never starts Z", () => {
    const policy = { ...defaultIndexPolicy(), quiet: true };
    const scheduled = scheduleIndex(
      [job("run", { status: "running" }), job("z", { ignored: true, status: "queued" })],
      policy,
      new Date("2026-11-15T15:00:00"),
    );
    expect(scheduled.find((item) => item.id === "run")).toMatchObject({ status: "paused", pauseReason: "quiet" });
    expect(scheduled.find((item) => item.id === "z")?.status).toBe("cancelled");
    expect(quietActive(policy, new Date("2026-11-15T22:00:00"))).toBe(true);
    expect(chunkGapMs(policy)).toBeGreaterThan(chunkGapMs({ ...defaultIndexPolicy(), quiet: false, processPriority: "normal" }));
  });

  it("keeps the cursor when a running job is reopened after restart", () => {
    const [reopened] = reopenAfterRestart([
      job("disk", { status: "running", checkpoint: { recordsDone: 12, recordsTotal: 40, mftOffset: 8192, nextUsn: "20" } }),
    ]);
    expect(reopened).toMatchObject({ status: "paused", pauseReason: "restart", checkpoint: { recordsDone: 12, nextUsn: "20" } });
    const resumed = controlIndex([reopened], "disk", "resume", 5);
    expect(resumed[0]).toMatchObject({ status: "queued", pauseReason: null, checkpoint: { recordsDone: 12 } });
  });

  it("keeps the published catalog until the new pass completes", () => {
    const published = ["old"];
    const paused = mergeIndexFiles(published, [], ["partial"], false);
    expect(paused).toEqual({ published: ["old"], partial: ["partial"] });
    const done = mergeIndexFiles(paused.published, paused.partial, ["tail"], true);
    expect(done).toEqual({ published: ["partial", "tail"], partial: [] });
    expect(mergeIndexFiles(published, [], [], true)).toEqual({ published: ["old"], partial: [] });
  });

  it("reports speed, eta, current file, and queue progress", () => {
    const started = noteIndexChunk(job("disk", { status: "running", totalBytes: 1_000, sampleAt: 1_000, sampleBytes: 100 }), {
      recordsDone: 5,
      recordsTotal: 10,
      mftOffset: 50,
      nextUsn: null,
      currentFile: "Cinema/movie.mkv",
      processedBytes: 600,
      totalBytes: 1_000,
    }, 2_000);
    const progress = jobProgress(started);
    expect(progress.currentFile).toBe("Cinema/movie.mkv");
    expect(progress.progress).toBeCloseTo(0.5);
    expect(progress.speed).toBeCloseTo(500);
    expect(progress.eta).toBe(1);
    const queue = queueProgress([started, job("other", { status: "paused", processedBytes: 100, totalBytes: 100 })]);
    expect(queue.active).toBe(1);
    expect(queue.paused).toBe(1);
    expect(queue.processedBytes).toBe(700);
  });

  it("does not queue a disk whose letter or mount is Z", () => {
    const disk = {
      id: "z",
      label: "Data",
      volumeName: "Data",
      lastMountPath: "Z:\\",
      totalBytes: 4_000_000_000_000,
      freeBytes: 1,
      filesystem: "NTFS",
      scan: { status: "idle", strategy: "mft-usn", progress: 0, message: "", elevated: true },
    } as DiskRecord;
    expect(disksToIndexJobs([disk])).toEqual([]);
    const unhealthy = { ...disk, id: "e", lastMountPath: "E:\\" };
    const alcohol = { ...disk, id: "f", lastMountPath: "F:\\", volumeName: "виртуальный диск Alcohol" };
    expect(disksToIndexJobs([unhealthy, alcohol])).toEqual([]);
  });

  it("pauses and cancels the whole queue without dropping cursors", () => {
    const paused = controlIndex(
      [job("a", { status: "running", checkpoint: { recordsDone: 2, recordsTotal: 8, mftOffset: 1, nextUsn: null } }), job("b", { status: "queued" })],
      null,
      "pause-all",
      3,
    );
    expect(paused.every((item) => item.status === "paused" && item.pauseReason === "user")).toBe(true);
    expect(paused[0]?.checkpoint.recordsDone).toBe(2);
    const cancelled = controlIndex(paused, null, "cancel-all", 4);
    expect(cancelled.every((item) => item.status === "cancelled")).toBe(true);
    expect(cancelled[0]?.checkpoint.recordsDone).toBe(2);
  });
});
