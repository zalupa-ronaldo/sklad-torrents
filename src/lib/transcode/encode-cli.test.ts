import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const root = process.cwd();
const node = process.execPath;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(dir: string, args: string[], extra: Record<string, string> = {}): { status: number; json: Record<string, unknown>; stdout: string } {
  const result = spawnSync(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args, "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", ...extra },
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}";
  return { status: result.status ?? 1, json: JSON.parse(line) as Record<string, unknown>, stdout: result.stdout || "" };
}

it("probes the real HandBrakeCLI list and does not claim PC, Mac, or hardware AV1", async () => {
  const dir = await scratch();
  const probe = run(dir, ["encode", "probe"]);
  expect(probe.status).toBe(0);
  expect(probe.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  expect(probe.json).toMatchObject({
    ok: true,
    present: true,
    hardwareAv1: false,
    videoToolbox: null,
    platform: "linux",
    pcVerified: false,
    macVerified: false,
    compact: false,
    started: false,
  });
  expect(probe.json.encoders).toEqual(expect.arrayContaining(["svt_av1", "x264"]));
  expect(String(probe.json.version)).toMatch(/^\d+\.\d+\.\d+$/);
  const missing = run(dir, ["encode", "probe"], { SKLAD_HANDBRAKE: "/no/such/HandBrakeCLI" });
  expect(missing.status).toBe(3);
  expect(missing.json.present).toBe(false);
});

it("encodes a tiny fixture to AV1, verifies it, and does not delete a source outside the owned temp dir", async () => {
  const dir = await scratch();
  const source = path.join(dir, "outside.mp4");
  const dest = path.join(dir, "out", "clip.mp4");
  await writeClip(source);
  await rm(path.join(dir, "out"), { recursive: true, force: true }).catch(() => undefined);
  await (await import("node:fs/promises")).mkdir(path.join(dir, "out"));
  const before = await stat(source);
  const encoded = run(dir, ["encode", "run", "--source", source, "--dest", dest, "--codec", "av1"]);
  expect(encoded.status).toBe(0);
  expect(encoded.json).toMatchObject({ verified: true, codec: "av1", pcVerified: false, macVerified: false, subjectiveQuality: false, sourceDeleted: false });
  expect((await stat(source)).size).toBe(before.size);
  const output = await stat(dest);
  expect(output.size).toBeGreaterThan(0);
  expect(output.ino).not.toBe(before.ino);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { state: string; verified: boolean; sourceDeleted: boolean }[] };
  expect(jobs.jobs).toEqual([expect.objectContaining({ state: "done", verified: true, sourceDeleted: false })]);
  const again = run(dir, ["encode", "--source", source, "--dest", dest, "--codec", "av1"]);
  expect(again.status).toBe(3);
  expect(String(again.json.error)).toMatch(/уже есть/);
  expect((await stat(dest)).size).toBe(output.size);
});

it("removes only an owned temporary source after a smaller verified output, and keeps it for a torrent or a failed check", async () => {
  const dir = await scratch();
  const owned = path.join(dir, "encode-owned");
  await (await import("node:fs/promises")).mkdir(owned, { recursive: true });
  const source = path.join(owned, "mine.mp4");
  const dest = path.join(dir, "kept.mp4");
  await writeClip(source);
  const done = run(dir, ["encode", "run", "--source", source, "--dest", dest, "--codec", "av1"]);
  expect(done.status).toBe(0);
  expect(done.json.verified).toBe(true);
  if (done.json.sizeBenefit === true) {
    await expect(stat(source)).rejects.toThrow();
    expect(done.json.sourceDeleted).toBe(true);
  } else {
    expect((await stat(source)).isFile()).toBe(true);
    expect(done.json.sourceDeleted).toBe(false);
  }
  expect((await stat(dest)).size).toBeGreaterThan(0);

  const torrentSource = path.join(owned, "torrent.mp4");
  const torrentDest = path.join(dir, "torrent-out.mp4");
  await writeClip(torrentSource);
  const held = run(dir, ["encode", "run", "--source", torrentSource, "--dest", torrentDest, "--codec", "av1", "--torrent", "ab".repeat(20)]);
  expect(held.status).toBe(0);
  expect(held.json.sourceDeleted).toBe(false);
  expect((await stat(torrentSource)).isFile()).toBe(true);

  const failedSource = path.join(dir, "still.mp4");
  const failedDest = path.join(dir, "late.mp4");
  await writeClip(failedSource);
  const timed = run(dir, ["encode", "run", "--source", failedSource, "--dest", failedDest, "--codec", "av1"], { SKLAD_ENCODE_TIMEOUT_MS: "1" });
  expect(timed.json.verified).not.toBe(true);
  await expect(stat(failedDest)).rejects.toThrow();
  expect((await stat(failedSource)).isFile()).toBe(true);
});

it("refuses AV1 when hardware is required and this Linux build has none", async () => {
  const dir = await scratch();
  const source = path.join(dir, "in.mp4");
  const dest = path.join(dir, "no.mp4");
  await writeClip(source);
  const blocked = run(dir, ["encode", "--source", source, "--dest", dest, "--codec", "av1", "--hardware-only"]);
  expect(blocked.status).toBe(3);
  expect(String(blocked.json.error || blocked.json.reason || "")).toMatch(/HEVC|AV1|аппаратного/i);
  await expect(stat(dest)).rejects.toThrow();
  const jobs = await readFile(path.join(dir, "jobs.json"), "utf8").catch(() => "{\"jobs\":[]}");
  expect(JSON.parse(jobs).jobs).toEqual([]);
});

it("lets two Linux worker processes encode two videos without sharing an output", async () => {
  const dir = await scratch();
  const first = path.join(dir, "a.mp4");
  const second = path.join(dir, "b.mp4");
  const outA = path.join(dir, "a-out.mp4");
  const outB = path.join(dir, "b-out.mp4");
  await writeClip(first);
  await writeClip(second);
  expect(run(dir, ["encode", "--source", first, "--dest", outA, "--codec", "av1"]).status).toBe(0);
  expect(run(dir, ["encode", "--source", second, "--dest", outB, "--codec", "av1"]).status).toBe(0);
  const children = ["a", "b"].map(() => spawn(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", "encode", "work", "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", SKLAD_ENCODE_HOLD_MS: "400" },
  }));
  const results = await Promise.all(children.map((child) => new Promise<string>((resolve) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.on("close", () => resolve(text));
  })));
  const bodies = results.map((text) => JSON.parse(text.trim().split("\n").filter(Boolean).at(-1) || "{}") as { verified?: boolean; jobId?: string });
  expect(bodies.every((body) => body.verified === true)).toBe(true);
  expect(new Set(bodies.map((body) => body.jobId)).size).toBe(2);
  const left = await stat(outA);
  const right = await stat(outB);
  expect(left.ino).not.toBe(right.ino);
  expect(left.size).toBeGreaterThan(0);
  expect(right.size).toBeGreaterThan(0);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { state: string; verified: boolean }[] };
  expect(jobs.jobs).toHaveLength(2);
  expect(jobs.jobs.every((job) => job.state === "done" && job.verified)).toBe(true);
});

it("does not publish a destination after a crash, cancel, or a forbidden Windows path", async () => {
  const dir = await scratch();
  const source = path.join(dir, "in.mp4");
  const dest = path.join(dir, "out.mp4");
  await writeClip(source);
  const queued = run(dir, ["encode", "--source", source, "--dest", dest, "--codec", "av1"]);
  expect(queued.status).toBe(0);
  const crashed = run(dir, ["encode", "work"], { SKLAD_ENCODE_EXIT: "86" });
  expect(crashed.status).toBe(86);
  await expect(stat(dest)).rejects.toThrow();
  const recovered = run(dir, ["encode", "work"]);
  expect(recovered.json.verified).toBe(true);
  expect((await stat(dest)).size).toBeGreaterThan(0);
  expect((await stat(source)).isFile()).toBe(true);

  const other = path.join(dir, "other.mp4");
  const otherDest = path.join(dir, "other-out.mp4");
  await writeClip(other);
  const id = String(run(dir, ["encode", "--source", other, "--dest", otherDest, "--codec", "av1"]).json.jobId);
  const cancelled = run(dir, ["encode", "cancel", "--id", id]);
  expect(cancelled.json).toMatchObject({ verified: false, ready: false });
  expect(run(dir, ["encode", "work"]).json.processed).toBe(false);
  await expect(stat(otherDest)).rejects.toThrow();

  const forbidden = run(dir, ["encode", "--source", "E:\\films\\a.mkv", "--dest", path.join(dir, "no.mp4"), "--codec", "av1"]);
  expect(forbidden.status).not.toBe(0);
  expect(String(forbidden.json.error)).toMatch(/E и Z/);
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-encode-"));
  dirs.push(dir);
  return dir;
}

async function writeClip(file: string): Promise<void> {
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=8:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "1500k",
    "-c:a", "aac", "-b:a", "64k", "-shortest", file,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "ffmpeg не собрал ролик.");
}
