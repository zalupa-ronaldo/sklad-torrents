import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createJobStore } from "@/lib/jobs/engine";
import { localJobHost } from "@/lib/jobs/local-host";
import { startEncodeHub } from "@/lib/encode-remote/hub";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("gives each machine the file that already lives there and does not ship it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-claim-"));
  dirs.push(dir);
  const host = localJobHost();
  expect(host).toBeTruthy();
  const store = createJobStore(dir);
  await store.enqueue({
    kind: "transcode",
    host: host!,
    source: "D:\\Films\\new.mkv",
    destination: "D:\\Films\\new-out.mkv",
    handbrakeProfile: "c:av1:sw",
  });
  await store.enqueue({
    kind: "transcode",
    host: host!,
    source: "/Volumes/vault/old.mkv",
    destination: "/Volumes/vault/old-out.mkv",
    handbrakeProfile: "c:av1:sw",
  });
  const token = randomBytes(16).toString("hex");
  const hub = await startEncodeHub({ token, directory: dir });
  closers.push(hub.close);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${hub.port}`;
  for (const worker of [
    { id: "pc-1", role: "pc", platform: "win32", encoders: ["svt_av1", "vce_h264"] },
    { id: "mac-1", role: "mac", platform: "darwin", encoders: ["svt_av1", "vt_h264"] },
  ]) {
    const registered = await fetch(`${base}/v1/workers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...worker, slots: 1, freeBytes: 8_000_000_000 }),
    });
    expect(registered.status).toBe(200);
  }
  const mac = await fetch(`${base}/v1/jobs/claim`, { method: "POST", headers, body: JSON.stringify({ id: "mac-1" }) });
  const pc = await fetch(`${base}/v1/jobs/claim`, { method: "POST", headers, body: JSON.stringify({ id: "pc-1" }) });
  const macBody = await mac.json() as { job: { ship?: boolean; sourcePath?: string; bytes?: number } | null };
  const pcBody = await pc.json() as { job: { ship?: boolean; sourcePath?: string; bytes?: number } | null };
  expect(macBody.job).toMatchObject({ ship: false, sourcePath: "/Volumes/vault/old.mkv", bytes: 0 });
  expect(pcBody.job).toMatchObject({ ship: false, sourcePath: "D:\\Films\\new.mkv", bytes: 0 });
});
