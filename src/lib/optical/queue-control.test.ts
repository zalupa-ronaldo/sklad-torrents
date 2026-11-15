import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mutateJobs, readJobs } from "@/lib/jobs/store";
import type { BackgroundJob } from "@/lib/jobs/types";
import "@/lib/optical/jobs";
import "@/lib/optical/progress-source";
import { listRegisteredJobs } from "@/lib/progress/sources";
import { demoDrives } from "@/lib/optical/demo";
import { sha256 } from "@/lib/optical/checksum";
import {
  pauseOpticalJob,
  recoverOpticalAfterRestart,
  resetOpticalRuntimeForTests,
  resumeOpticalQueue,
  writeOpticalLoad,
} from "@/lib/optical/control";
import { enqueueOptical, opticalIdle, setRunnerForTests, setSourceReaderForTests } from "@/lib/optical/burn";
import { createMockRunner } from "@/lib/optical/runner";
import type { IndexedPath } from "@/lib/optical/media";

const booklet: IndexedPath = {
  diskLabel: "Vault",
  path: "D:\\Cinema\\booklet.pdf",
  name: "booklet.pdf",
  size: 3,
  kind: "file",
};

describe("optical queue control", () => {
  let dir = "";
  let release: () => void = () => undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-optical-queue-"));
    process.env.SKLAD_DATA_DIR = dir;
    delete process.env.SKLAD_OPTICAL_DEMO;
    resetOpticalRuntimeForTests();
    setRunnerForTests(null);
    setSourceReaderForTests(null);
    release = () => undefined;
  });

  afterEach(async () => {
    release();
    await opticalIdle();
    setRunnerForTests(null);
    setSourceReaderForTests(null);
    resetOpticalRuntimeForTests();
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("pauses a running burn on the queue boundary and resumes the next step", async () => {
    const source = path.join(dir, "booklet.pdf");
    await writeFile(source, "abc");
    const gate = deferred();
    release = gate.resolve;
    const runner = createMockRunner({ hold: gate.promise });
    setRunnerForTests(runner);
    setSourceReaderForTests(async (file) => (file === booklet.path ? new Uint8Array([97, 98, 99]) : null));
    const job = await enqueueOptical(burnInput());
    await waitFor(() => runner.calls.length === 1);
    await writeOpticalLoad({ queuePaused: true });
    gate.resolve();
    const paused = await waitForJob(job.id, "paused");
    expect(runner.calls.length).toBe(1);
    expect(paused.bytesDone).toBeGreaterThan(0);
    expect(paused.currentFile).toBeTruthy();
    expect(paused.payload.pausedBy).toBe("queue");
    expect(await readFile(source, "utf8")).toBe("abc");

    await resumeOpticalQueue();
    const done = await waitForJob(job.id, "done");
    expect(runner.calls.length).toBe(3);
    expect(done.payload.sourceSha256).toBe(sha256(new TextEncoder().encode(`D:\\Cinema\\booklet.pdf\n${sha256(new Uint8Array([97, 98, 99]))}`)));
    expect(done.hardware).toBe(false);
    expect(await readFile(source, "utf8")).toBe("abc");
  });

  it("suspends a running burn when the machine should not be disturbed", async () => {
    const gate = deferred();
    release = gate.resolve;
    const runner = createMockRunner({ hold: gate.promise });
    setRunnerForTests(runner);
    const job = await enqueueOptical(burnInput());
    await waitFor(() => runner.calls.length === 1);
    await writeOpticalLoad({ disturb: true });
    gate.resolve();
    const paused = await waitForJob(job.id, "paused");
    expect(paused.payload.pausedBy).toBe("disturb");
    expect(runner.calls.length).toBe(1);
    await writeOpticalLoad({ disturb: false });
    await resumeOpticalQueue();
    const done = await waitForJob(job.id, "done");
    expect(done.status).toBe("done");
    expect(runner.calls.length).toBe(3);
  });

  it("keeps a user pause across a queue resume and does not delete the source", async () => {
    const source = path.join(dir, "booklet.pdf");
    await writeFile(source, "abc");
    const gate = deferred();
    release = gate.resolve;
    const runner = createMockRunner({ hold: gate.promise });
    setRunnerForTests(runner);
    const job = await enqueueOptical(burnInput());
    await waitFor(() => runner.calls.length === 1);
    await pauseOpticalJob(job.id);
    gate.resolve();
    const paused = await waitForJob(job.id, "paused");
    expect(paused.payload.pausedBy).toBe("user");
    await resumeOpticalQueue();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const still = (await readJobs()).find((item) => item.id === job.id);
    expect(still?.status).toBe("paused");
    expect(await readFile(source, "utf8")).toBe("abc");
  });

  it("pauses a burn from the shared progress action and keeps the source", async () => {
    const source = path.join(dir, "booklet.pdf");
    await writeFile(source, "abc");
    const gate = deferred();
    release = gate.resolve;
    const runner = createMockRunner({ hold: gate.promise });
    setRunnerForTests(runner);
    setSourceReaderForTests(async () => new Uint8Array([97, 98, 99]));
    const job = await enqueueOptical(burnInput());
    await waitFor(() => runner.calls.length === 1);
    const { performJobAction } = await import("@/lib/progress/jobs");
    const notice = await performJobAction(`optical__${job.id}`, "pause");
    expect(notice.notice).toMatch(/не удалялись/);
    gate.resolve();
    const paused = await waitForJob(job.id, "paused");
    expect(paused.payload.pausedBy).toBe("user");
    expect(await readFile(source, "utf8")).toBe("abc");
    const burn = (await listRegisteredJobs()).find((item) => item.id === `optical__${job.id}`);
    expect(burn?.deleteAllowed).toBe(false);
    expect(burn?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a forbidden volume before a job exists", async () => {
    setRunnerForTests(createMockRunner());
    const hidden: IndexedPath = { ...booklet, path: "Z:\\secret\\a.bin", name: "a.bin" };
    await expect(enqueueOptical(burnInput([hidden]))).rejects.toThrow(/Диск Z:/);
    expect(await readJobs()).toEqual([]);
  });

  it("shows a DiscImageStudio job once, with pause, and keeps burn jobs on the burn source", async () => {
    await mutateJobs((jobs) => {
      jobs.push(stored("art-job", "running", 20, "disc-image-studio"), stored("burn-job", "running", 30, "optical.burn"));
    });
    const snaps = await listRegisteredJobs();
    const art = snaps.filter((job) => job.id === "optical__art-job");
    const burn = snaps.filter((job) => job.id === "optical__burn-job");
    expect(art).toHaveLength(1);
    expect(art[0]?.capabilities.pause).toBe(true);
    expect(art[0]?.currentFile).toContain("a.iso");
    expect(burn).toHaveLength(1);
    expect(burn[0]?.status).toBe("running");
    expect(burn[0]?.processedBytes).toBe(30);
    expect(burn[0]?.speed).toBeGreaterThan(0);
  });

  it("keeps a paused job paused after restart and requeues a dead running job at the same step", async () => {
    await mutateJobs((jobs) => {
      jobs.push(stored("paused-job", "paused", 40), stored("running-job", "running", 55));
    });
    expect(await recoverOpticalAfterRestart()).toBe(1);
    const jobs = await readJobs();
    const paused = jobs.find((job) => job.id === "paused-job");
    const running = jobs.find((job) => job.id === "running-job");
    expect(paused?.status).toBe("paused");
    expect(paused?.bytesDone).toBe(40);
    expect(paused?.currentFile).toBe("a.iso");
    expect(running?.status).toBe("queued");
    expect(running?.bytesDone).toBe(55);
    expect(running?.currentFile).toBe("a.iso");
    expect(running?.payload.stepIndex).toBe(1);
  });
});

function burnInput(files: IndexedPath[] = [booklet]) {
  const drive = demoDrives()[0];
  return {
    action: "burn" as const,
    demo: true,
    profile: "dvd-sl" as const,
    driveId: drive?.id,
    files,
    outputDir: "D:\\Cinema",
    label: "Саундтрек",
    locationNote: "полка",
    eraseConfirmed: false,
  };
}

function stored(
  id: string,
  status: BackgroundJob["status"],
  bytesDone: number,
  kind = "optical.burn",
): BackgroundJob {
  const now = new Date(Date.now() - 5000).toISOString();
  return {
    id,
    kind,
    status,
    phase: "запись",
    percent: bytesDone,
    currentFile: "a.iso",
    bytesDone,
    bytesTotal: 100,
    title: "Запись",
    error: null,
    mock: true,
    hardware: false,
    idempotencyKey: id,
    host: "pc-agent",
    claimedBy: null,
    createdAt: now,
    updatedAt: now,
    payload: { stepIndex: 1 },
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

async function waitForJob(id: string, status: string) {
  await waitFor(async () => {
    const job = (await readJobs()).find((item) => item.id === id);
    return job?.status === status;
  });
  const job = (await readJobs()).find((item) => item.id === id);
  if (!job) throw new Error("job disappeared");
  return job;
}
