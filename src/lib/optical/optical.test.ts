import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readJobs } from "@/lib/jobs/store";
import { listDiscs } from "@/lib/optical/catalog";
import { demoDrives } from "@/lib/optical/demo";
import { OpticalError } from "@/lib/optical/errors";
import { createMockRunner, createToolRunner } from "@/lib/optical/runner";
import { searchBurnedFiles } from "@/lib/optical/search";
import { enqueueOptical, opticalIdle, readOpticalPayload, setRunnerForTests, type EnqueueInput } from "@/lib/optical/burn";
import type { DetectResult, IndexedPath, OpticalDrive } from "@/lib/optical/media";

const booklet: IndexedPath = {
  diskLabel: "Vault",
  path: "/Volumes/vault/Music/NieR Automata OST/booklet.pdf",
  name: "booklet.pdf",
  size: 12_000_000,
  kind: "file",
};

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("optical jobs", () => {
  let dir = "";
  let release: () => void = () => undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-optical-"));
    process.env.SKLAD_DATA_DIR = dir;
    delete process.env.SKLAD_OPTICAL_DEMO;
    setRunnerForTests(null);
    release = () => undefined;
  });

  afterEach(async () => {
    release();
    await opticalIdle();
    setRunnerForTests(null);
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("returns the queued job before the mock process finishes", async () => {
    const gate = deferred();
    release = gate.resolve;
    const runner = createMockRunner({ hold: gate.promise });
    setRunnerForTests(runner);
    const started = Date.now();
    const job = await enqueueOptical(burnInput());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(job.status).toBe("queued");
    expect(job.mock).toBe(true);
    expect(job.hardware).toBe(false);
    expect(job.payload.erase).toBe(false);
    expect(job.payload.steps.flatMap((step) => step.argv)).not.toContain("-erase");

    await waitFor(async () => runner.calls.length > 0);
    const mid = await readJobs();
    expect(mid.find((item) => item.id === job.id)?.status).not.toBe("done");

    gate.resolve();
    const done = await waitForJob(job.id, "done");
    expect(done.mock).toBe(true);
    expect(done.hardware).toBe(false);
    expect(done.status).toBe("done");
    const payload = readOpticalPayload(done);
    expect(payload.verified).toBe(true);
    expect(payload.source).toBe("mock");
    const bins = runner.calls.map((call) => call.argv[0]);
    expect(bins).toContain("hdiutil");
    expect(bins).toContain("drutil");
    expect(runner.calls.some((call) => call.argv.includes("makehybrid"))).toBe(true);
    expect(runner.calls.some((call) => call.argv.includes("checksum"))).toBe(true);
  });

  it("rejects a duplicate active burn", async () => {
    const gate = deferred();
    release = gate.resolve;
    setRunnerForTests(createMockRunner({ hold: gate.promise }));
    await enqueueOptical(burnInput());
    await expect(enqueueOptical(burnInput())).rejects.toBeInstanceOf(OpticalError);
    await expect(enqueueOptical(burnInput())).rejects.toThrow(/уже в очереди/);
    const jobs = await readJobs();
    expect(jobs.filter((job) => job.kind === "optical.burn")).toHaveLength(1);
  });

  it("does not catalog a disc when verify fails", async () => {
    setRunnerForTests(createMockRunner({ verifyCode: 1 }));
    const job = await enqueueOptical(burnInput());
    const done = await waitForJob(job.id, "error");
    expect(done.mock).toBe(true);
    expect(done.hardware).toBe(false);
    expect(readOpticalPayload(done).verified).toBe(false);
    expect(await listDiscs()).toEqual([]);
  });

  it("catalogs a successful mock verify as mock and finds the offline shelf", async () => {
    setRunnerForTests(createMockRunner());
    const job = await enqueueOptical(burnInput());
    const done = await waitForJob(job.id, "done");
    expect(done.mock).toBe(true);
    expect(done.hardware).toBe(false);
    const discs = await listDiscs();
    expect(discs).toHaveLength(1);
    expect(discs[0]?.source).toBe("mock");
    expect(discs[0]?.hardwareSerial).toBeNull();
    expect(discs[0]?.idOrigin).toBe("generated");
    expect(discs[0]?.locationNote).toBe("полка, коробка 2");
    const hits = searchBurnedFiles(discs, "booklet.pdf", []);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.offline).toBe(true);
    expect(hits[0]?.source).toBe("mock");
    expect(hits[0]?.message).toContain("полка, коробка 2");
    expect(hits[0]?.message).toContain("не в приводе");
    expect(hits[0]?.message).toContain("не настоящий диск");
  });

  it("does not add a catalog row for a mock runner outside demo mode", async () => {
    setRunnerForTests(createMockRunner());
    const drive = realDrive();
    const job = await enqueueOptical({ ...burnInput(drive), demo: false, outputDir: dir }, { detect: detectWith(drive) });
    const done = await waitForJob(job.id, "done");
    expect(done.mock).toBe(true);
    expect(done.hardware).toBe(false);
    expect(await listDiscs()).toEqual([]);
  });

  it("errors the job when the burner is not installed", async () => {
    setRunnerForTests(createToolRunner(async () => null));
    const drive = realDrive();
    const job = await enqueueOptical({ ...burnInput(drive), demo: false, outputDir: dir }, { detect: detectWith(drive) });
    const done = await waitForJob(job.id, "error");
    expect(done.mock).toBe(false);
    expect(done.hardware).toBe(false);
    expect(done.error).toMatch(/Утилита не найдена/);
    expect(readOpticalPayload(done).verified).toBe(false);
    expect(await listDiscs()).toEqual([]);
  });

  it("rejects an oversized tree before creating a job", async () => {
    setRunnerForTests(createMockRunner());
    const huge: IndexedPath = { ...booklet, size: 62_400_000_000, name: "Interstellar.2014.2160p.mkv" };
    await expect(enqueueOptical(burnInput(macDemo(), [huge], "cd"))).rejects.toThrow(/Не влезает/);
    expect(await readJobs()).toEqual([]);
  });
});

function macDemo(): OpticalDrive {
  const drive = demoDrives()[0];
  if (!drive) throw new Error("demo drive missing");
  return drive;
}

function burnInput(drive: OpticalDrive = macDemo(), files: IndexedPath[] = [booklet], profile: EnqueueInput["profile"] = "dvd-sl"): EnqueueInput {
  return {
    action: "burn",
    demo: true,
    profile,
    driveId: drive.id,
    files,
    outputDir: "/Volumes/vault/Cinema",
    label: "Саундтрек",
    locationNote: "полка, коробка 2",
    eraseConfirmed: false,
  };
}

function realDrive(): OpticalDrive {
  return { ...macDemo(), id: "darwin:/dev/disk2", demo: false };
}

function detectWith(drive: OpticalDrive): () => Promise<DetectResult> {
  return async () => ({ status: "ok", drives: [drive], detail: "" });
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

async function waitForJob(id: string, status: "done" | "error") {
  let last = "";
  await waitFor(async () => {
    const jobs = await readJobs();
    const job = jobs.find((item) => item.id === id);
    last = job?.status ?? "missing";
    return job?.status === status;
  }).catch(async (error) => {
    throw new Error(`${String(error)} (last status ${last})`);
  });
  const job = (await readJobs()).find((item) => item.id === id);
  if (!job) throw new Error("job disappeared");
  return job;
}
