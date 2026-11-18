import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createJobStore } from "@/lib/jobs/engine";
import { startMockWorker } from "@/lib/jobs/mock-worker";

const move = {
  kind: "move" as const,
  host: "mac-local" as const,
  source: "/Volumes/vault/Cinema/A.mkv",
  destination: "/Volumes/vault/Cinema/Watched/A.mkv",
  diskId: "vault",
};

describe("idle job worker", () => {
  let dir = "";
  const stops: Array<() => void> = [];

  afterEach(async () => {
    for (const stop of stops) stop();
    stops.length = 0;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("claims once when the queue stays empty", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-idle-"));
    const store = createJobStore(dir);
    let claims = 0;
    const original = store.claimNext.bind(store);
    store.claimNext = async (host) => {
      claims += 1;
      return original(host);
    };
    stops.push(startMockWorker(store, "mac-local", { intervalMs: 10, steps: 1 }).stop);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(claims).toBe(1);
  });

  it("wakes when a job is enqueued", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-idle-"));
    const store = createJobStore(dir);
    let claims = 0;
    const original = store.claimNext.bind(store);
    store.claimNext = async (host) => {
      claims += 1;
      return original(host);
    };
    stops.push(startMockWorker(store, "mac-local", { intervalMs: 5, steps: 1 }).stop);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = claims;
    await store.enqueue(move);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(claims).toBeGreaterThan(before);
  });
});
