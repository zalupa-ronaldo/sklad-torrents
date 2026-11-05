import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as claimPost } from "@/app/api/jobs/[id]/claim/route";
import { GET as eventsGet } from "@/app/api/jobs/events/route";
import { GET, POST } from "@/app/api/jobs/route";
import { createJobStore, getJobStore } from "@/lib/jobs/engine";
import { formatSse } from "@/lib/jobs/http";
import { setMockWorkerGateForTests } from "@/lib/jobs/mock-worker";
import { resetJobRuntimeForTests } from "@/lib/jobs/runtime";
import type { JobHost, JobKind } from "@/lib/jobs/model";

const move = {
  kind: "move" as const,
  host: "mac-local" as const,
  source: "/Volumes/vault/Cinema/Interstellar.mkv",
  destination: "/Volumes/vault/Cinema/Watched/Interstellar.mkv",
  diskId: "vault",
};

describe("file job queue", () => {
  let dir: string;
  let releaseGate: (() => void) | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-jobs-"));
    process.env.SKLAD_DATA_DIR = dir;
    process.env.SKLAD_JOB_WORKERS = "0";
    delete process.env.SKLAD_JOB_TICK_MS;
    resetJobRuntimeForTests();
  });

  afterEach(async () => {
    releaseGate?.();
    releaseGate = null;
    resetJobRuntimeForTests();
    delete process.env.SKLAD_JOB_WORKERS;
    delete process.env.SKLAD_JOB_TICK_MS;
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("POST enqueue returns before the mock worker finishes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseGate = release;
    setMockWorkerGateForTests(gate);
    process.env.SKLAD_JOB_WORKERS = "1";
    process.env.SKLAD_JOB_TICK_MS = "15";
    const pending = POST(jsonRequest(move));
    const response = await Promise.race([
      pending,
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("handler waited for the worker")), 800);
      }),
    ]);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { job: { id: string; state: string; sourceDeleted: boolean } };
    expect(body.job.state).not.toBe("done");
    expect(body.job.sourceDeleted).toBe(false);
    const live = await createJobStore(dir).get(body.job.id);
    expect(live?.state).not.toBe("done");
  });

  it("returns the same job id for a duplicate idempotency key", async () => {
    const store = createJobStore(dir);
    const first = await store.enqueue(move);
    const second = await store.enqueue(move);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect((await store.list({ offset: 0, limit: 20 })).total).toBe(1);
    const viaHttp = await POST(jsonRequest(move));
    const body = (await viaHttp.json()) as { job: { id: string } };
    expect(body.job.id).toBe(first.job.id);
  });

  it("does not let two workers claim the same job", async () => {
    const store = createJobStore(dir);
    const { job } = await store.enqueue(move);
    const [first, second] = await Promise.all([store.claim(job.id, "mac-local"), store.claim(job.id, "mac-local")]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].some((result) => !result.ok && result.reason === "conflict")).toBe(true);
    const response = await claimPost(jsonRequest({ host: "mac-local" }), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(409);

    const mac = await store.enqueue({
      kind: "transcode",
      host: "mac-local",
      source: "/Volumes/vault/Cinema/A.mkv",
      destination: "/Volumes/vault/Cinema/A.mp4",
      handbrakeProfile: "Apple 1080p30",
    });
    const pc = await store.enqueue({
      kind: "compact",
      host: "pc-agent",
      source: "D:\\Games\\Control",
      destination: "D:\\Games\\Control",
      compactAlgorithm: "XPRESS16K",
    });
    const [macClaim, pcClaim] = await Promise.all([
      store.claim(mac.job.id, "mac-local"),
      store.claim(pc.job.id, "pc-agent"),
    ]);
    expect(macClaim.ok && pcClaim.ok).toBe(true);
  });

  it("keeps jobs when a new store opens the same directory", async () => {
    const first = createJobStore(dir);
    const created = await first.enqueue(move);
    const second = createJobStore(dir);
    const loaded = await second.get(created.job.id);
    expect(loaded).toMatchObject({
      id: created.job.id,
      state: "queued",
      kind: "move",
      host: "mac-local",
      sourceDeleted: false,
    });
    expect((await second.list({ offset: 0, limit: 10 })).total).toBe(1);
  });

  it("runs queued to done and retries an error without deleting the source", async () => {
    const store = createJobStore(dir);
    const created = await store.enqueue({ ...move, kind: "copy", destination: "/Volumes/vault/Cinema/copy.mkv" });
    expect(created.job.state).toBe("queued");
    expect(created.job.sourceDeleted).toBe(false);
    const claimed = await store.claim(created.job.id, "mac-local");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const done = await store.complete(created.job.id, claimed.job.workerToken || "");
    expect(done?.state).toBe("done");
    expect(done?.verified).toBe(true);
    expect(done?.sourceDeleted).toBe(false);

    const failing = await store.enqueue({
      kind: "move",
      host: "pc-agent",
      source: "D:\\Downloads\\a.bin",
      destination: "E:\\Archive\\a.bin",
    });
    let current = failing.job;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = await store.claim(current.id, "pc-agent");
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const failed = await store.fail(current.id, run.job.workerToken || "", "сбой чтения");
      expect(failed?.sourceDeleted).toBe(false);
      expect(failed?.payload.source).toBe("D:\\Downloads\\a.bin");
      if (attempt < 2) expect(failed?.state).toBe("queued");
      else expect(failed?.state).toBe("error");
      current = failed ?? current;
    }
    const retried = await store.retry(current.id);
    expect(retried.state).toBe("queued");
    expect(retried.sourceDeleted).toBe(false);

    const verified = await store.enqueue({
      kind: "transcode",
      host: "mac-local",
      source: "/Volumes/vault/Cinema/B.mkv",
      destination: "/Volumes/vault/Cinema/B.mp4",
      handbrakeProfile: "Apple 1080p30",
    });
    const running = await store.claim(verified.job.id, "mac-local");
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    await store.markVerified(verified.job.id, running.job.workerToken || "");
    const stopped = await store.fail(verified.job.id, running.job.workerToken || "", "после проверки");
    expect(stopped?.state).toBe("error");
    expect(stopped?.verified).toBe(true);
    expect(stopped?.sourceDeleted).toBe(false);
  });

  it("emits progress events with percent and bytes", async () => {
    const store = getJobStore();
    const { job } = await store.enqueue(move);
    const claimed = await store.claim(job.id, job.host);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    await store.updateProgress(job.id, claimed.job.workerToken || "", {
      percent: 40,
      processedBytes: 400,
      totalBytes: 1000,
      speed: 80,
      etaSeconds: 8,
      currentFile: "Interstellar.mkv",
    });
    const progress = store.getEventLog().filter((event) => event.type === "progress");
    expect(progress.some((event) => event.type === "progress" && event.percent === 40 && event.processedBytes === 400)).toBe(true);
    const last = progress.at(-1);
    expect(last && formatSse(last)).toContain('"percent":40');
    expect(last && formatSse(last)).toContain('"processedBytes":400');

    const response = await eventsGet();
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    if (!reader) return;
    await store.updateProgress(job.id, claimed.job.workerToken || "", {
      percent: 55,
      processedBytes: 550,
      totalBytes: 1000,
      speed: 80,
      etaSeconds: 5,
      currentFile: "Interstellar.mkv",
    });
    const text = await readUntil(reader, (chunk) => chunk.includes('"percent":55') && chunk.includes('"processedBytes":550'));
    expect(text).toContain('"processedBytes":550');
    await reader.cancel();
  });

  it("returns only the requested page", async () => {
    const store = createJobStore(dir);
    for (let index = 0; index < 5; index += 1) {
      await store.enqueue({
        kind: index % 2 === 0 ? "copy" : "move",
        host: (index % 2 === 0 ? "mac-local" : "pc-agent") satisfies JobHost,
        source: `/src/${index}`,
        destination: `/dst/${index}`,
      });
    }
    const page = await store.list({ offset: 0, limit: 2 });
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.jobs.length).toBeLessThan(page.total);
    const response = await GET(new Request("http://127.0.0.1/api/jobs?offset=0&limit=2"));
    const body = (await response.json()) as { jobs: unknown[]; total: number };
    expect(body.jobs).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(JSON.stringify(body)).not.toContain("fileTree");
  });
});

function jsonRequest(body: { kind: JobKind; host: JobHost; source: string; destination: string; diskId?: string; handbrakeProfile?: string; compactAlgorithm?: string }) {
  return new Request("http://127.0.0.1/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, ready: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), 200);
      }),
    ]);
    if (next.value) text += decoder.decode(next.value);
    if (ready(text)) return text;
    if (next.done) break;
  }
  return text;
}
