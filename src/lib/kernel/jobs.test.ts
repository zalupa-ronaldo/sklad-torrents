import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkladError } from "@/lib/kernel/errors";
import { cancelJob, claimNext, compareAndSetJob, enqueueJob, failJob, getJob, listJobs, pauseJob, retryJob } from "@/lib/kernel/jobs";

describe("job queue", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-jobs-"));
    process.env.SKLAD_DATA_DIR = dir;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("returns the same active job for the same source, destination, kind and host", async () => {
    const input = {
      kind: "move" as const,
      hostId: "demo-pc",
      title: "Копия",
      source: "D:\\Games\\Control",
      destination: "F:\\Games\\Control",
    };
    const [first, second] = await Promise.all([enqueueJob(input), enqueueJob(input)]);
    expect(first.job.id).toBe(second.job.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    const otherHost = await enqueueJob({ ...input, hostId: "demo-mac" });
    expect(otherHost.job.id).not.toBe(first.job.id);
    expect((await listJobs()).filter((job) => job.state === "queued")).toHaveLength(2);
  });

  it("lets two agents claim different jobs and never the same one", async () => {
    await enqueueJob({ kind: "index", hostId: "demo-mac", title: "Mac", source: "disk:a", destination: "disk:a" });
    await enqueueJob({ kind: "index", hostId: "demo-pc", title: "PC", source: "disk:b", destination: "disk:b" });
    const [mac, pc, again] = await Promise.all([
      claimNext("agent-mac", "demo-mac"),
      claimNext("agent-pc", "demo-pc"),
      claimNext("agent-mac-2", "demo-mac"),
    ]);
    expect(mac?.hostId).toBe("demo-mac");
    expect(pc?.hostId).toBe("demo-pc");
    expect(again).toBeNull();
    expect(mac?.claimToken).toBeTruthy();
    expect(mac?.claimToken).not.toBe(pc?.claimToken);
  });

  it("rejects a compare-and-set when the version moved", async () => {
    const { job } = await enqueueJob({ kind: "copy", hostId: "demo-pc", title: "A", source: "D:\\a", destination: "F:\\a" });
    const won = await compareAndSetJob(job.id, job.version, { state: "running", claimToken: "token-1", claimedBy: "mac" });
    const lost = await compareAndSetJob(job.id, job.version, { state: "running", claimToken: "token-2", claimedBy: "pc" });
    expect(won?.claimedBy).toBe("mac");
    expect(lost).toBeNull();
  });

  it("retries without deleting the source and stops after the bound", async () => {
    const { job } = await enqueueJob({
      kind: "move",
      hostId: "demo-pc",
      title: "Копия",
      source: "D:\\Games\\Control",
      destination: "F:\\Games\\Control",
      maxAttempts: 3,
    });
    let current = job;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await claimNext("agent", "demo-pc");
      expect(claimed?.id).toBe(current.id);
      current = await failJob(current.id, "сбой чтения");
      expect(current.payload.sourceDeleted).toBe(false);
      expect(current.source).toBe("D:\\Games\\Control");
      if (attempt < 2) current = await retryJob(current.id);
    }
    await expect(retryJob(current.id)).rejects.toThrow(SkladError);
    expect((await getJob(current.id)).payload.sourceDeleted).toBe(false);
  });

  it("says in Russian when pause is unsupported and cancel keeps files", async () => {
    const { job } = await enqueueJob({
      kind: "transcode",
      hostId: "demo-mac",
      title: "HandBrake",
      source: "/Volumes/vault/Cinema/a.mkv",
      destination: "/Volumes/vault/Cinema/a.mp4",
    });
    await expect(pauseJob(job.id)).rejects.toThrow(/пауз/i);
    const cancelled = await cancelJob(job.id);
    expect(cancelled.message).toMatch(/не удалялись/);
    expect(cancelled.payload.sourceDeleted).toBe(false);
  });
});
