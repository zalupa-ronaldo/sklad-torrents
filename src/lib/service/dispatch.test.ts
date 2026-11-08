import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const root = process.cwd();
const node = process.execPath;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => {
    spawnSync(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", "service", "stop", "--json"], {
      cwd: root,
      env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0" },
      encoding: "utf8",
    });
    await rm(dir, { recursive: true, force: true });
  }));
});

it("lets one service verify a game copy and an encode without a manual work command", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-dispatch-"));
  dirs.push(dir);
  const pool = path.join(dir, "pool");
  const source = path.join(dir, "Fixture");
  await mkdir(path.join(source, "saves"), { recursive: true });
  await mkdir(pool);
  await writeFile(path.join(source, "data.bin"), "payload-bytes");
  await writeFile(path.join(source, "saves", "slot.txt"), "1");
  const exe = path.join(source, "play.mjs");
  await writeFile(exe, "#!/usr/bin/env node\n");
  await chmod(exe, 0o755);
  await writeFile(path.join(source, "sklad-game.json"), JSON.stringify({ name: "Fixture", steamAppId: 424242, exe: "play.mjs", args: [], saves: ["saves/slot.txt"] }));
  const db = path.join(dir, "compact.json");
  await writeFile(db, JSON.stringify([{ SteamID: 424242, GameName: "Fixture", FolderName: "Fixture", Confidence: 2, CompressionResults: [{ CompType: 1, BeforeBytes: 1000, AfterBytes: 950, TotalResults: 2 }], TotalFiles: 1 }]));
  const clip = path.join(dir, "clip.mp4");
  const encoded = path.join(dir, "out.mp4");
  const ffmpeg = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=8:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { encoding: "utf8" });
  expect(ffmpeg.status).toBe(0);

  const env = { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", SKLAD_SERVICE_TICK_MS: "50", SKLAD_COMPACT_DB: db };
  const started = run(env, ["service", "start"]);
  expect(started.status).toBe(0);
  expect(run(env, ["service", "start"]).json.already).toBe(true);
  expect(run(env, ["game", "register", "--root", source, "--pool", pool]).status).toBe(0);
  const id = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8")).games[0].id as string;
  expect(run(env, ["game", "prepare", "--id", id, "--compact-db", db]).status).toBe(0);
  expect(run(env, ["encode", "--source", clip, "--dest", encoded, "--codec", "av1"]).status).toBe(0);

  const ready = await wait(dir, 40_000);
  expect(ready.game.copyVerified).toBe(true);
  expect(ready.game.ready).toBe(true);
  expect(ready.game.compressed).toBe(false);
  expect(ready.game.ntfsSmoke).toBe(false);
  expect(ready.game.compact).toBe("skipped");
  expect(ready.encode.state).toBe("done");
  expect(ready.encode.verified).toBe(true);
  expect(ready.jobs).toHaveLength(2);

  expect(run(env, ["service", "stop"]).status).toBe(0);
  expect(run(env, ["service", "start"]).status).toBe(0);
  await delay(800);
  const after = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string; state: string }[] };
  expect(after.jobs).toHaveLength(2);
  expect(after.jobs.map((job) => job.id).sort()).toEqual(ready.ids.sort());
  expect(after.jobs.every((job) => job.state === "done")).toBe(true);
  expect(run(env, ["service", "stop"]).status).toBe(0);
}, 60_000);

function run(env: NodeJS.ProcessEnv, args: string[]) {
  const result = spawnSync(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args, "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}";
  return { status: result.status ?? 1, json: JSON.parse(line) as Record<string, unknown> };
}

async function wait(dir: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const library = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8")) as { games: { copyVerified: boolean; ready: boolean; compressed: boolean; ntfsSmoke: boolean; compact: string }[] };
    const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8").catch(() => "{\"jobs\":[]}")) as { jobs: { id: string; kind: string; state: string; verified: boolean }[] };
    const encode = jobs.jobs.find((job) => job.kind === "transcode");
    const game = library.games[0];
    if (game?.copyVerified && game.ready && encode?.state === "done" && encode.verified) {
      return { game, encode, jobs: jobs.jobs, ids: jobs.jobs.map((job) => job.id) };
    }
    await delay(200);
  }
  throw new Error("Служба не довела игру и кодирование без ручного work.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
