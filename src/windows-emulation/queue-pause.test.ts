import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createJobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";
import { toJobCard } from "@/lib/progress/view";
import type { JobSnapshot } from "@/lib/progress/types";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("queue pause on the emulated machines", () => {
  it("keeps a paused HandBrake file, its bytes, and the partial result across a restart", async () => {
    const dir = await scratch();
    const source = path.join(dir, "film.mkv");
    const partial = path.join(dir, "film.partial.mkv");
    await writeFile(source, "original-picture");
    await writeFile(partial, "partial-picture");
    const sourceHash = await sha(source);
    const partialHash = await sha(partial);

    const store = createJobStore(dir);
    const first = await store.enqueue({
      kind: "transcode",
      host: "pc-agent",
      source,
      destination: path.join(dir, "film.av1.mkv"),
      handbrakeProfile: "c:av1:sw",
    });
    const second = await store.enqueue({
      kind: "transcode",
      host: "pc-agent",
      source: path.join(dir, "next.mkv"),
      destination: path.join(dir, "next.av1.mkv"),
      handbrakeProfile: "c:av1:sw",
    });
    const claimed = await store.claimNext("pc-agent");
    expect(claimed?.id).toBe(first.job.id);
    await store.updateProgress(claimed!.id, claimed!.workerToken || "", {
      percent: 40,
      processedBytes: 400,
      totalBytes: 1000,
      speed: 80,
      etaSeconds: 8,
      currentFile: "film.mkv",
    });
    await store.pause(claimed!.id);

    const restarted = createJobStore(dir);
    const paused = await restarted.get(first.job.id);
    expect(paused?.state).toBe("paused");
    expect(paused?.workerToken).toBeNull();
    expect(paused?.progress).toMatchObject({ percent: 40, processedBytes: 400, currentFile: "film.mkv" });
    const waiting = await restarted.get(second.job.id);
    expect(waiting?.state).toBe("queued");
    expect(waiting?.progress.processedBytes).toBe(0);

    await restarted.pause(second.job.id);
    expect(await restarted.claimNext("pc-agent")).toBeNull();
    expect((await restarted.list()).counts).toMatchObject({ paused: 2, queued: 0, running: 0 });

    await restarted.resume(first.job.id);
    const continued = await restarted.claimNext("pc-agent");
    expect(continued?.id).toBe(first.job.id);
    expect(continued?.progress.processedBytes).toBe(400);
    expect(continued?.progress.currentFile).toBe("film.mkv");
    expect(await sha(source)).toBe(sourceHash);
    expect(await sha(partial)).toBe(partialHash);
    expect(await readFile(source, "utf8")).toBe("original-picture");
  });

  it("pauses one machine without releasing the other, and shows percent, speed, ETA and the current file", async () => {
    const dir = await scratch();
    const store = createJobStore(dir);
    const kinds = ["transcode", "compact", "copy", "index"] as const;
    const jobs = [];
    for (const kind of kinds) {
      jobs.push(await store.enqueue(sample(kind, "pc-agent", dir)));
      jobs.push(await store.enqueue(sample(kind, "mac-local", dir)));
    }
    for (const created of jobs) {
      if (created.job.host !== "pc-agent") continue;
      const running = await store.claim(created.job.id, "pc-agent");
      if (!running.ok) continue;
      await store.updateProgress(running.job.id, running.job.workerToken || "", {
        percent: 25,
        processedBytes: 250,
        totalBytes: 1000,
        speed: 50,
        etaSeconds: 15,
        currentFile: path.basename(running.job.payload.source || "index"),
      });
      await store.pause(running.job.id);
    }
    expect(await store.claimNext("pc-agent")).toBeNull();
    const mac = await store.claimNext("mac-local");
    expect(mac?.host).toBe("mac-local");
    expect(mac?.state).toBe("running");

    const paused = (await store.list({ host: "pc-agent" })).jobs.filter((job) => job.state === "paused");
    expect(paused).toHaveLength(kinds.length);
    const cards = paused.map(cardOf);
    expect(cards.every((card) => card.percentLabel !== "0%" && card.canResume && card.canCancel)).toBe(true);
    expect(cards[0]?.etaLabel).toBe("на паузе");
    expect(cards[0]?.speedLabel).toContain("/с");
    expect(cards[0]?.currentFile).toBeTruthy();
    const processed = paused.reduce((sum, job) => sum + job.progress.processedBytes, 0);
    const total = paused.reduce((sum, job) => sum + job.progress.totalBytes, 0);
    expect(processed).toBe(250 * kinds.length);
    expect(total).toBe(1000 * kinds.length);

    const cancelled = await store.cancel(paused[0]!.id);
    expect(cancelled.state).toBe("error");
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.sourceDeleted).toBe(false);
  });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-pause-"));
  dirs.push(dir);
  return dir;
}

async function sha(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function sample(kind: "transcode" | "compact" | "copy" | "index", host: "pc-agent" | "mac-local", dir: string) {
  const leaf = `${host}-${kind}`;
  if (kind === "index") return { kind, host, source: path.join(dir, leaf), diskId: leaf };
  if (kind === "compact") {
    return { kind, host, source: path.join(dir, leaf), compactAlgorithm: "XPRESS8K" };
  }
  return {
    kind,
    host,
    source: path.join(dir, `${leaf}-in`),
    destination: path.join(dir, `${leaf}-out`),
    handbrakeProfile: kind === "transcode" ? "c:av1:sw" : undefined,
  };
}

function cardOf(job: Job) {
  const kind = job.kind === "transcode" || job.kind === "compact" || job.kind === "copy" || job.kind === "index" ? job.kind : "copy";
  const snapshot: JobSnapshot = {
    id: job.id,
    kind,
    title: job.kind,
    status: "paused",
    progress: job.progress.percent / 100,
    processedBytes: job.progress.processedBytes,
    totalBytes: job.progress.totalBytes,
    speed: job.progress.speed,
    eta: job.progress.etaSeconds ?? 8_640_000,
    currentFile: job.progress.currentFile,
    host: job.host,
    diskLabel: null,
    outputPath: job.payload.destination || null,
    error: job.lastError,
    capabilities: { pause: true, resume: true, cancel: true },
    pauseUnsupportedReason: null,
    updatedAt: Date.parse(job.updatedAt),
  };
  return toJobCard(snapshot);
}
