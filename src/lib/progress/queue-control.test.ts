import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as queuePost } from "@/app/api/jobs/queue/route";
import { POST as enqueuePost } from "@/app/api/jobs/route";
import { POST as resumePost } from "@/app/api/jobs/[id]/resume/route";
import { getJobStore, resetJobStoreForTests } from "@/lib/jobs/engine";
import { resetJobRuntimeForTests } from "@/lib/jobs/runtime";
import type { JobHost } from "@/lib/jobs/model";
import type { LinkStatus } from "@/lib/progress/channel";
import { observeLink, readControl, resetQueueControlForTests, setQueueClock, writeControl } from "@/lib/progress/control";
import { controlStoredJobs, pauseAll, saveLoad } from "@/lib/progress/queue-actions";
import { summarize } from "@/lib/progress/summary";
import type { JobSnapshot } from "@/lib/progress/types";

const copy = {
  kind: "copy" as const,
  host: "mac-local" as const,
  source: "/Volumes/vault/Cinema/Interstellar.mkv",
  destination: "/Volumes/vault/Cinema/copy.mkv",
};

describe("shared task queue", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-queue-"));
    process.env.SKLAD_DATA_DIR = dir;
    process.env.SKLAD_JOB_WORKERS = "0";
    resetJobRuntimeForTests();
    resetQueueControlForTests();
  });

  afterEach(async () => {
    resetJobRuntimeForTests();
    resetQueueControlForTests();
    delete process.env.SKLAD_JOB_WORKERS;
    delete process.env.SKLAD_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a HandBrake pause, the byte offset, and the original after a new store opens", async () => {
    const original = path.join(dir, "original.mkv");
    await writeFile(original, "original-bytes");
    const store = getJobStore();
    const created = await store.enqueue({
      kind: "transcode",
      host: "mac-local",
      source: original,
      destination: path.join(dir, "out.mp4"),
      handbrakeProfile: "Apple 1080p30",
    });
    const claimed = await store.claim(created.job.id, "mac-local");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    await store.updateProgress(created.job.id, claimed.job.workerToken || "", {
      percent: 40,
      processedBytes: 400,
      totalBytes: 1000,
      speed: 10,
      etaSeconds: 60,
      currentFile: "original.mkv",
    });
    const paused = await store.pause(created.job.id);
    expect(paused.sourceDeleted).toBe(false);
    expect(paused.verified).toBe(false);
    expect(await readFile(original, "utf8")).toBe("original-bytes");

    resetJobStoreForTests();
    resetQueueControlForTests();
    const reopened = getJobStore();
    const loaded = await reopened.get(created.job.id);
    expect(loaded?.state).toBe("paused");
    expect(loaded?.progress.processedBytes).toBe(400);
    expect(loaded?.progress.currentFile).toBe("original.mkv");
    expect(loaded?.sourceDeleted).toBe(false);
    expect(await reopened.claimNext("mac-local")).toBeNull();
    await reopened.resume(created.job.id);
    const continued = await reopened.claimNext("mac-local");
    expect(continued?.id).toBe(created.job.id);
    expect(continued?.progress.processedBytes).toBe(400);
    expect(await readFile(original, "utf8")).toBe("original-bytes");
  });

  it("pauses the queue across a restart and does not resume a task the user paused", async () => {
    const store = getJobStore();
    const user = await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/user.mkv", destination: "/Volumes/vault/Cinema/user-copy.mkv" });
    const queued = await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/queued.mkv", destination: "/Volumes/vault/Cinema/queued-copy.mkv" });
    await store.pause(user.job.id);
    await controlStoredJobs("pause", "all");
    const fresh = path.join(dir, "later.mkv");
    await writeFile(fresh, "later");
    await store.enqueue({ ...copy, source: fresh, destination: path.join(dir, "later-copy.mkv") });
    resetQueueControlForTests();
    resetJobStoreForTests();
    const reopened = getJobStore();
    expect(await reopened.claimNext("mac-local")).toBeNull();
    expect((await reopened.get(user.job.id))?.state).toBe("paused");
    expect((await reopened.get(queued.job.id))?.state).toBe("paused");
    const response = await resumePost(new Request("http://127.0.0.1/api/jobs"), { params: Promise.resolve({ id: user.job.id }) });
    expect(response.status).toBe(409);
    expect((await reopened.get(user.job.id))?.state).toBe("paused");
    await controlStoredJobs("resume", "all");
    expect((await reopened.get(user.job.id))?.state).toBe("paused");
    expect((await reopened.get(queued.job.id))?.state).toBe("queued");
    expect(await readFile(fresh, "utf8")).toBe("later");
  });

  it("gives Mac and PC their own next HandBrake file and their own slot", async () => {
    const store = getJobStore();
    const control = await readControl();
    control.load.handbrakeSlots = { "mac-local": 1, "pc-agent": 1 };
    control.load.maxParallel = { "mac-local": 3, "pc-agent": 2, "linux-local": 2 };
    await writeControl(control);
    await store.enqueue(transcode("mac-local", "/Volumes/vault/Cinema/a.mkv", "/Volumes/vault/Cinema/a.mp4"));
    await store.enqueue(transcode("mac-local", "/Volumes/vault/Cinema/b.mkv", "/Volumes/vault/Cinema/b.mp4"));
    await store.enqueue(transcode("pc-agent", "D:\\Movies\\c.mkv", "D:\\Movies\\c.mp4"));
    await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/notes.txt", destination: "/Volumes/vault/Cinema/notes-copy.txt" });
    const mac = await store.claimNext("mac-local");
    const macAgain = await store.claimNext("mac-local");
    const pc = await store.claimNext("pc-agent");
    expect(mac?.payload.source).toBe("/Volumes/vault/Cinema/a.mkv");
    expect(macAgain?.kind).toBe("copy");
    expect(pc?.payload.source).toBe("D:\\Movies\\c.mkv");
    expect(await store.claimNext("pc-agent")).toBeNull();
    control.load.handbrakeSlots["mac-local"] = 2;
    await writeControl(control);
    const second = await store.claimNext("mac-local");
    expect(second?.payload.source).toBe("/Volumes/vault/Cinema/b.mkv");
  });

  it("does not move a file to the other machine and refuses Z:", async () => {
    const moved = await enqueuePost(json({
      kind: "transcode",
      host: "pc-agent",
      source: "/Volumes/vault/Cinema/local.mkv",
      destination: "/Volumes/vault/Cinema/local.mp4",
      handbrakeProfile: "Apple 1080p30",
    }));
    expect(moved.status).toBe(202);
    const movedBody = (await moved.json()) as { job: { host: string; sourceDeleted: boolean }; notice: string };
    expect(movedBody.job.host).toBe("mac-local");
    expect(movedBody.job.sourceDeleted).toBe(false);
    expect(movedBody.notice).toContain("SHA-256");
    expect(movedBody.notice).toContain("не удаляется");

    const blocked = await enqueuePost(json({
      kind: "transcode",
      host: "pc-agent",
      source: "Z:\\private-token\\clip.mkv",
      destination: "D:\\out\\clip.mp4",
      handbrakeProfile: "AMD",
    }));
    expect(blocked.status).toBe(400);
    const text = await blocked.text();
    expect(text).toContain("Диск Z:");
    expect(text).not.toContain("private-token");

    const store = getJobStore();
    const parked = await store.enqueue({
      kind: "copy",
      host: "pc-agent",
      source: "Z:\\private-token\\clip.mkv",
      destination: "D:\\out\\clip-copy.mkv",
    });
    expect(await store.claimNext("pc-agent")).toBeNull();
    expect((await store.get(parked.job.id))?.sourceDeleted).toBe(false);
  });

  it("limits load with a schedule and while someone is using the machine", async () => {
    const store = getJobStore();
    const control = await readControl();
    control.load.maxParallel["mac-local"] = 1;
    control.load.schedule = { enabled: true, startMinute: 60, endMinute: 480 };
    await writeControl(control);
    setQueueClock(() => new Date(2026, 10, 15, 23, 30).getTime());
    await store.enqueue(copy);
    expect(await store.claimNext("mac-local")).toBeNull();
    setQueueClock(() => new Date(2026, 10, 15, 2, 0).getTime());
    const first = await store.claimNext("mac-local");
    expect(first?.state).toBe("running");
    await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/second.mkv", destination: "/Volumes/vault/Cinema/second-copy.mkv" });
    expect(await store.claimNext("mac-local")).toBeNull();
    await store.enqueue({
      kind: "copy",
      host: "pc-agent",
      source: "D:\\Movies\\third.mkv",
      destination: "H:\\Movies\\third.mkv",
    });
    const current = await readControl();
    current.load.yieldWhileActive = true;
    current.load.userActive = { "mac-local": true, "pc-agent": false };
    current.load.schedule.enabled = false;
    await writeControl(current);
    expect(await store.claimNext("pc-agent")).not.toBeNull();
    expect((await store.list({ host: "mac-local", state: "queued" })).jobs.length).toBeGreaterThan(0);
  });

  it("does not burn retries or clear a user pause when the channel returns", async () => {
    const store = getJobStore();
    const held = await store.enqueue(copy);
    const claimed = await store.claim(held.job.id, "mac-local");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    await store.updateProgress(held.job.id, claimed.job.workerToken || "", {
      percent: 25,
      processedBytes: 250,
      totalBytes: 1000,
      speed: 5,
      etaSeconds: 10,
      currentFile: "Interstellar.mkv",
    });
    const failed = await store.fail(held.job.id, claimed.job.workerToken || "", "Канал socat не запущен.");
    expect(failed?.state).toBe("queued");
    expect(failed?.autoRetries).toBe(0);
    expect(failed?.progress.processedBytes).toBe(250);
    expect(failed?.sourceDeleted).toBe(false);
    expect(await store.claimNext("mac-local")).toBeNull();

    const manual = await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/manual.mkv", destination: "/Volumes/vault/Cinema/manual-copy.mkv" });
    await store.pause(manual.job.id);
    observeLink(upLink());
    expect((await store.get(manual.job.id))?.state).toBe("paused");
    const again = await store.claimNext("mac-local");
    expect(again?.id).toBe(held.job.id);
    expect(again?.progress.processedBytes).toBe(250);
    expect((await store.get(manual.job.id))?.state).toBe("paused");
  });

  it("lets a running HandBrake file finish and cancels without deleting the original", async () => {
    const original = path.join(dir, "film.mkv");
    await writeFile(original, "film");
    const store = getJobStore();
    const running = await store.enqueue({
      kind: "transcode",
      host: "pc-agent",
      source: original,
      destination: path.join(dir, "film.mp4"),
      handbrakeProfile: "AMD VCE",
    });
    const claimed = await store.claim(running.job.id, "pc-agent");
    expect(claimed.ok).toBe(true);
    const waiting = await store.enqueue({
      kind: "transcode",
      host: "pc-agent",
      source: path.join(dir, "next.mkv"),
      destination: path.join(dir, "next.mp4"),
      handbrakeProfile: "AMD VCE",
    });
    await writeFile(path.join(dir, "next.mkv"), "next");
    const result = await controlStoredJobs("pause", "pc-agent");
    expect(result.finishing).toBe(1);
    expect((await store.get(running.job.id))?.state).toBe("running");
    expect((await store.get(waiting.job.id))?.state).toBe("paused");
    await store.cancel(running.job.id);
    expect((await store.get(running.job.id))?.sourceDeleted).toBe(false);
    expect(await readFile(original, "utf8")).toBe("film");
    expect(await readFile(path.join(dir, "next.mkv"), "utf8")).toBe("next");
  });

  it("pauses CompactGUI while the machine is in use and resumes only that pause", async () => {
    const store = getJobStore();
    const compact = await store.enqueue({
      kind: "compact",
      host: "pc-agent",
      source: "D:\\Games\\Control",
      destination: "D:\\Games\\Control",
      compactAlgorithm: "XPRESS16K",
    });
    const control = await readControl();
    await saveLoad({ ...control.load, yieldWhileActive: true, userActive: { "mac-local": false, "pc-agent": true } });
    expect((await store.get(compact.job.id))?.state).toBe("paused");
    expect((await store.get(compact.job.id))?.sourceDeleted).toBe(false);
    await saveLoad({ ...control.load, yieldWhileActive: false, userActive: { "mac-local": false, "pc-agent": false } });
    expect((await store.get(compact.job.id))?.state).toBe("queued");
  });

  it("pause-all keeps a partial file, a user pause, and separate Mac and PC limits after a new process", async () => {
    const source = path.join(dir, "source.mkv");
    const partial = path.join(dir, "partial.mp4");
    await writeFile(source, "source-bytes");
    await writeFile(partial, "partial-bytes");
    const store = getJobStore();
    const user = await store.enqueue({ ...copy, source: "/Volumes/vault/Cinema/keep.mkv", destination: "/Volumes/vault/Cinema/keep-copy.mkv" });
    await store.pause(user.job.id);
    const running = await store.enqueue(transcode("pc-agent", source, partial));
    const claimed = await store.claim(running.job.id, "pc-agent");
    expect(claimed.ok).toBe(true);
    const waiting = await store.enqueue(transcode("mac-local", "/Volumes/vault/Cinema/wait.mkv", "/Volumes/vault/Cinema/wait.mp4"));
    const response = await queuePost(new Request("http://127.0.0.1/api/jobs/queue", {
      method: "POST",
      body: JSON.stringify({ action: "pause-all" }),
    }));
    expect(response.status).toBe(200);
    expect(await readFile(source, "utf8")).toBe("source-bytes");
    expect(await readFile(partial, "utf8")).toBe("partial-bytes");
    expect((await store.get(running.job.id))?.state).toBe("running");
    expect((await store.get(waiting.job.id))?.state).toBe("paused");
    expect((await store.get(user.job.id))?.state).toBe("paused");

    resetQueueControlForTests();
    resetJobStoreForTests();
    const reopened = getJobStore();
    expect((await readControl()).paused).toBe(true);
    expect((await reopened.get(waiting.job.id))?.state).toBe("paused");
    expect((await reopened.get(user.job.id))?.state).toBe("paused");
    expect(await readFile(partial, "utf8")).toBe("partial-bytes");
    expect(await reopened.claimNext("mac-local")).toBeNull();

    await saveLoad({
      quiet: true,
      processPriority: "below",
      quietHours: [{ startHour: 23, endHour: 7 }],
      mac: { handbrakeSlots: 1, maxParallel: 2 },
      pc: { handbrakeSlots: 2, maxParallel: 3 },
    });
    resetQueueControlForTests();
    const saved = await readControl();
    expect(saved.load.quiet).toBe(true);
    expect(saved.load.processPriority).toBe("below-normal");
    expect(saved.load.quietHours).toEqual([{ startHour: 23, endHour: 7 }]);
    expect(saved.load.handbrakeSlots).toEqual({ "mac-local": 1, "pc-agent": 2 });
    expect(saved.load.maxParallel["mac-local"]).toBe(2);
    expect(saved.load.maxParallel["pc-agent"]).toBe(3);
    const contract = JSON.parse(await readFile(path.join(dir, "load-contract.json"), "utf8")) as {
      quiet: boolean;
      processPriority: string;
      mac: { handbrakeSlots: number };
      pc: { handbrakeSlots: number };
      quietHours: { startHour: number; endHour: number }[];
    };
    expect(contract.quiet).toBe(true);
    expect(contract.processPriority).toBe("below-normal");
    expect(contract.mac.handbrakeSlots).toBe(1);
    expect(contract.pc.handbrakeSlots).toBe(2);
    expect(contract.quietHours).toEqual([{ startHour: 23, endHour: 7 }]);

    await saveLoad({ quiet: false, processPriority: "normal", quietHours: [], mac: { handbrakeSlots: 1 }, pc: { handbrakeSlots: 2 } });
    await pauseAll();
    await controlStoredJobs("resume", "all");
    expect((await getJobStore().get(user.job.id))?.state).toBe("paused");
    expect((await getJobStore().get(waiting.job.id))?.state).toBe("queued");
    setQueueClock(() => new Date(2026, 10, 15, 23, 30).getTime());
    await saveLoad({ quiet: false, quietHours: [{ startHour: 23, endHour: 7 }], processPriority: "idle" });
    expect(await getJobStore().claimNext("mac-local")).toBeNull();
    setQueueClock(() => new Date(2026, 10, 15, 12, 0).getTime());
    const next = await getJobStore().claimNext("mac-local");
    expect(next?.id).toBe(waiting.job.id);
    expect(await readFile(partial, "utf8")).toBe("partial-bytes");
    expect(await readFile(source, "utf8")).toBe("source-bytes");
  });

  it("keeps quiet mode when only the process priority is saved", async () => {
    await saveLoad({
      quiet: true,
      quietHours: [{ startHour: 23, endHour: 7 }],
      userActive: { "mac-local": true, "pc-agent": false },
      processPriority: "below-normal",
    });
    const saved = await saveLoad({ processPriority: "idle" });
    expect(saved.quiet).toBe(true);
    expect(saved.processPriority).toBe("idle");
    expect(saved.quietHours).toEqual([{ startHour: 23, endHour: 7 }]);
    expect(saved.userActive).toEqual({ "mac-local": true, "pc-agent": false });
    setQueueClock(() => new Date(2026, 10, 15, 12, 0).getTime());
    const store = getJobStore();
    await store.enqueue(copy);
    await store.enqueue({
      kind: "copy",
      host: "pc-agent",
      source: "D:\\Movies\\free.mkv",
      destination: "H:\\Movies\\free.mkv",
    });
    expect(await store.claimNext("mac-local")).toBeNull();
    expect((await store.claimNext("pc-agent"))?.host).toBe("pc-agent");
  });

  it("summarizes percent, speed, and the current file for the open queue", () => {
    const summary = summarize([
      snapshot({ status: "running", progress: 0.5, processedBytes: 500, totalBytes: 1000, speed: 100, currentFile: "a.mkv" }),
      snapshot({ id: "b", status: "queued", progress: 0, processedBytes: 0, totalBytes: 1000, speed: 0, currentFile: "b.mkv" }),
      snapshot({ id: "c", status: "completed", progress: 1, processedBytes: 9_000, totalBytes: 9_000, speed: 0 }),
    ]);
    expect(summary.percent).toBeCloseTo(0.25);
    expect(summary.speed).toBe(100);
    expect(summary.eta).toBe(15);
    expect(summary.currentFile).toBe("a.mkv");
    expect(summary.running).toBe(1);
    expect(summary.queued).toBe(1);
  });
});

function transcode(host: JobHost, source: string, destination: string) {
  return {
    kind: "transcode" as const,
    host,
    source,
    destination,
    handbrakeProfile: host === "mac-local" ? "Apple 1080p30" : "AMD VCE",
  };
}

function upLink(): LinkStatus {
  const peer = { qbittorrent: "up" as const, handbrake: "up" as const, detail: null };
  return { state: "up", peers: { "mac-local": peer, "pc-agent": peer } };
}

function json(body: unknown) {
  return new Request("http://127.0.0.1/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function snapshot(overrides: Partial<JobSnapshot>): JobSnapshot {
  return {
    id: "a",
    kind: "transcode",
    title: "encode",
    status: "running",
    progress: 0,
    processedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    currentFile: null,
    host: "mac-local",
    diskLabel: null,
    outputPath: null,
    error: null,
    capabilities: { pause: true, resume: false, cancel: true },
    pauseUnsupportedReason: null,
    updatedAt: 0,
    ...overrides,
  };
}
