import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { enqueueEncode } from "@/lib/transcode/encode-worker";
import { startEncodeHub } from "@/lib/encode-remote/hub";

const root = process.cwd();
const node = process.execPath;
const dirs: string[] = [];
const kids: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];

afterEach(async () => {
  for (const kid of kids.splice(0)) kid.kill("SIGTERM");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("encodes two videos on two workers with separate directories and no shared queue file", async () => {
  const coord = await scratch("coord");
  const workerA = await scratch("worker-a");
  const workerB = await scratch("worker-b");
  const token = randomBytes(16).toString("hex");
  const red = await clip(coord, "red");
  const blue = await clip(coord, "blue");
  const hub = spawnNode(coord, ["encode", "hub"], token);
  const port = await readPort(coord, hub);
  const hubUrl = `http://127.0.0.1:${port}`;
  spawnNode(workerA, ["encode", "worker", "--id", "worker-a", "--role", "pc"], token, { SKLAD_HUB: hubUrl, SKLAD_ENCODE_HOLD_MS: "1200" });
  spawnNode(workerB, ["encode", "worker", "--id", "worker-b", "--role", "mac"], token, { SKLAD_HUB: hubUrl, SKLAD_ENCODE_HOLD_MS: "1200" });
  expect((await enqueueEncode({ source: red, destination: path.join(coord, "red-out.mp4"), codec: "av1", allowSoftware: true, directory: coord })).ok).toBe(true);
  expect((await enqueueEncode({ source: blue, destination: path.join(coord, "blue-out.mp4"), codec: "av1", allowSoftware: true, directory: coord })).ok).toBe(true);
  const done = await waitJobs(coord, 2);
  expect(done.every((job) => job.state === "done" && job.verified)).toBe(true);
  const left = await stat(path.join(coord, "red-out.mp4"));
  const right = await stat(path.join(coord, "blue-out.mp4"));
  const replay = await fetch(`${hubUrl}/v1/jobs/${done[0]?.id}/finish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-lease": "not-a-lease" },
    body: JSON.stringify({ revision: 1, outputSha256: "b".repeat(64) }),
  });
  expect(replay.status).toBe(409);
  expect((await stat(path.join(coord, "red-out.mp4"))).size).toBe(left.size);
  expect(left.size).toBeGreaterThan(0);
  expect(right.size).toBeGreaterThan(0);
  expect(left.ino).not.toBe(right.ino);
  expect(await codecOf(path.join(coord, "red-out.mp4"))).toBe("av1");
  expect(await codecOf(path.join(coord, "blue-out.mp4"))).toBe("av1");
  expect(createHash("sha256").update(await readFile(path.join(coord, "red-out.mp4"))).digest("hex")).not.toBe(createHash("sha256").update(await readFile(path.join(coord, "blue-out.mp4"))).digest("hex"));
  const logs = [
    ...JSON.parse(await readFile(path.join(workerA, "encode-log.json"), "utf8")) as { pid: number; startedAt: number; finishedAt: number; verified: boolean }[],
    ...JSON.parse(await readFile(path.join(workerB, "encode-log.json"), "utf8")) as { pid: number; startedAt: number; finishedAt: number; verified: boolean }[],
  ].filter((row) => row.verified);
  expect(new Set(logs.map((row) => row.pid)).size).toBe(2);
  const overlap = logs.some((row, index) => logs.slice(index + 1).some((other) => row.startedAt < other.finishedAt && other.startedAt < row.finishedAt));
  expect(overlap).toBe(true);
  const [first, second] = logs;
  const overlapMs = first && second ? Math.min(first.finishedAt, second.finishedAt) - Math.max(first.startedAt, second.startedAt) : 0;
  expect(overlapMs).toBeGreaterThan(0);
  await expect(stat(path.join(workerA, "jobs.json"))).rejects.toThrow();
  await expect(stat(path.join(workerB, "jobs.json"))).rejects.toThrow();
  expect((await stat(red)).isFile()).toBe(true);
  expect((await stat(blue)).isFile()).toBe(true);
}, 90_000);

it("does not verify or delete the source when the worker is killed mid-job", async () => {
  const coord = await scratch("drop");
  const worker = await scratch("drop-worker");
  const token = randomBytes(16).toString("hex");
  const source = await clip(coord, "yellow");
  const hub = spawnNode(coord, ["encode", "hub"], token);
  const port = await readPort(coord, hub);
  const child = spawnNode(worker, ["encode", "worker", "--id", "drop", "--role", "pc"], token, { SKLAD_HUB: `http://127.0.0.1:${port}`, SKLAD_ENCODE_HOLD_MS: "20000" });
  expect((await enqueueEncode({ source, destination: path.join(coord, "yellow-out.mp4"), codec: "av1", allowSoftware: true, directory: coord })).ok).toBe(true);
  const started = Date.now();
  let staged = false;
  while (Date.now() - started < 15_000) {
    try {
      await stat(path.join(worker, "staging"));
      staged = true;
      break;
    } catch {
      await delay(50);
    }
  }
  expect(staged).toBe(true);
  child.kill("SIGKILL");
  await delay(400);
  const parsed = JSON.parse(await readFile(path.join(coord, "jobs.json"), "utf8")) as { jobs: { verified: boolean; state: string }[] };
  expect(parsed.jobs[0]?.verified).toBe(false);
  expect(parsed.jobs[0]?.state).not.toBe("done");
  await expect(stat(path.join(coord, "yellow-out.mp4"))).rejects.toThrow();
  expect((await stat(source)).isFile()).toBe(true);
}, 30_000);

it("rejects anonymous calls, bad hashes, expired leases, unsupported codecs, arbitrary paths, and E:", async () => {
  const dir = await scratch("sec");
  const token = randomBytes(16).toString("hex");
  const previous = process.env.SKLAD_LEASE_MS;
  process.env.SKLAD_LEASE_MS = "500";
  const hub = await startEncodeHub({ token, directory: dir });
  const base = `http://127.0.0.1:${hub.port}`;
  expect((await fetch(base + "/v1/workers", { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(base + "/v1/jobs/../../etc/passwd/input", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  await expect(enqueueEncode({ source: "E:\\films\\a.mp4", destination: path.join(dir, "out.mp4"), codec: "av1", allowSoftware: true, directory: dir })).rejects.toThrow(/E и Z/);
  await expect(enqueueEncode({ source: path.join(dir, "in.mp4"), destination: "Z:\\out.mp4", codec: "av1", allowSoftware: true, directory: dir })).rejects.toThrow(/E и Z/);
  const source = await clip(dir, "green");
  const queued = await enqueueEncode({ source, destination: path.join(dir, "sec-out.mp4"), codec: "av1", allowSoftware: true, directory: dir });
  expect(queued.ok).toBe(true);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(base + "/v1/workers", { method: "POST", headers: auth, body: JSON.stringify({ id: "only-x264", role: "pc", platform: "linux", encoders: ["x264"], slots: 1, freeBytes: 1_000_000_000 }) });
  const denied = await (await fetch(base + "/v1/jobs/claim", { method: "POST", headers: auth, body: JSON.stringify({ id: "only-x264" }) })).json() as { job: unknown };
  expect(denied.job).toBeNull();
  await fetch(base + "/v1/workers", { method: "POST", headers: auth, body: JSON.stringify({ id: "av1-worker", role: "mac", platform: "linux", encoders: ["svt_av1"], slots: 1, freeBytes: 1_000_000_000 }) });
  const claimed = await (await fetch(base + "/v1/jobs/claim", { method: "POST", headers: auth, body: JSON.stringify({ id: "av1-worker" }) })).json() as { job: { jobId: string; lease: string; bytes: number } };
  const bad = await fetch(`${base}/v1/jobs/${claimed.job.jobId}/output?offset=0`, { method: "PUT", headers: { authorization: auth.authorization, "x-lease": claimed.job.lease, "x-chunk-sha256": "0".repeat(64) }, body: Buffer.from("nope") });
  expect(bad.status).toBe(400);
  const piece = Buffer.from("abcd");
  const pieceSha = createHash("sha256").update(piece).digest("hex");
  const first = await fetch(`${base}/v1/jobs/${claimed.job.jobId}/output?offset=0`, { method: "PUT", headers: { authorization: auth.authorization, "x-lease": claimed.job.lease, "x-chunk-sha256": pieceSha }, body: piece });
  expect(first.status).toBe(200);
  const replay = await fetch(`${base}/v1/jobs/${claimed.job.jobId}/output?offset=0`, { method: "PUT", headers: { authorization: auth.authorization, "x-lease": claimed.job.lease, "x-chunk-sha256": pieceSha }, body: piece });
  expect(replay.status).toBe(409);
  const rest = Buffer.from("efgh");
  const continued = await fetch(`${base}/v1/jobs/${claimed.job.jobId}/output?offset=4`, { method: "PUT", headers: { authorization: auth.authorization, "x-lease": claimed.job.lease, "x-chunk-sha256": createHash("sha256").update(rest).digest("hex") }, body: rest });
  expect(continued.status).toBe(200);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { verified: boolean }[] };
  expect(jobs.jobs.every((job) => job.verified === false)).toBe(true);
  await delay(700);
  await fetch(base + "/v1/workers", { method: "POST", headers: auth, body: JSON.stringify({ id: "second", role: "pc", platform: "linux", encoders: ["svt_av1"], slots: 1, freeBytes: 1_000_000_000 }) });
  const again = await (await fetch(base + "/v1/jobs/claim", { method: "POST", headers: auth, body: JSON.stringify({ id: "second" }) })).json() as { job: { lease: string } | null };
  expect(again.job?.lease).toBeTruthy();
  expect(again.job?.lease).not.toBe(claimed.job.lease);
  const late = await fetch(base + `/v1/jobs/${claimed.job.jobId}/finish`, { method: "POST", headers: { ...auth, "x-lease": claimed.job.lease }, body: JSON.stringify({ revision: 1, outputSha256: "a".repeat(64) }) });
  expect(late.status).toBe(409);
  const after = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string; verified: boolean }[] };
  expect(after.jobs).toHaveLength(1);
  expect(after.jobs[0]?.verified).toBe(false);
  await hub.close();
  const restarted = await startEncodeHub({ token, directory: dir });
  const persisted = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
  expect(persisted.jobs).toHaveLength(1);
  await restarted.close();
  if (previous === undefined) delete process.env.SKLAD_LEASE_MS;
  else process.env.SKLAD_LEASE_MS = previous;
  await expect(startEncodeHub({ token, directory: dir, bind: "0.0.0.0" })).rejects.toThrow(/127\.0\.0\.1/);
});

async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `sklad-${name}-`));
  dirs.push(dir);
  return dir;
}

function spawnNode(dir: string, args: string[], token: string, extra: Record<string, string> = {}) {
  const child = spawn(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", SKLAD_WORKER_TOKEN: token, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  return child;
}

async function readPort(dir: string, child: { stdout: NodeJS.ReadableStream | null }): Promise<number> {
  const started = Date.now();
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  while (Date.now() - started < 10_000) {
    const line = text.trim().split("\n").filter(Boolean).at(-1);
    if (line) {
      const parsed = JSON.parse(line) as { port?: number };
      if (parsed.port) return parsed.port;
    }
    await delay(50);
  }
  throw new Error("Хаб не поднялся.");
}

async function clip(dir: string, color: string): Promise<string> {
  const file = path.join(dir, `${color}.mp4`);
  const result = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=8:d=1`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "ffmpeg");
  return file;
}

async function waitJobs(dir: string, count: number): Promise<{ id: string; state: string; verified: boolean }[]> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string; state: string; verified: boolean }[] };
      if (parsed.jobs.length >= count && parsed.jobs.every((job) => job.state === "done" && job.verified)) return parsed.jobs;
    } catch {
      /* not yet */
    }
    await delay(200);
  }
  throw new Error("Удалённые воркеры не сдали оба ролика.");
}

async function codecOf(file: string): Promise<string> {
  const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file], { encoding: "utf8" });
  return result.stdout.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
