import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { GET } from "@/app/api/jobs/route";
import { coldGameBlocksDelete } from "@/lib/games/library";

const root = process.cwd();
const node = process.execPath;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(dir: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args, "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", ...extra },
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}";
  return { status: result.status ?? 1, json: JSON.parse(line) as Record<string, unknown> };
}

it("copies a tiny game, verifies hashes, and shows the same library on the jobs API", async () => {
  const dir = await scratch();
  const db = await compactDb(dir);
  const source = await gameDir(dir, "Fixture", 424242);
  const pool = path.join(dir, "pool");
  await mkdir(pool);
  const registered = run(dir, ["game", "register", "--root", source, "--pool", pool]);
  expect(registered.status).toBe(0);
  const id = String((registered.json.game as { id: string }).id);
  expect(registered.json.game).toMatchObject({ provenance: "manifest", confidence: "high", compressed: false, pinned: "until-explicit-remove" });

  const prepared = run(dir, ["game", "prepare", "--id", id]);
  expect(prepared.status).toBe(0);
  const again = run(dir, ["game", "prepare", "--id", id]);
  expect(again.json.created).toBe(false);
  const worked = run(dir, ["game", "work", "--compact-db", db]);
  expect(worked.json).toMatchObject({ verified: true, ready: true, compressed: false, compact: "skipped", executed: false, pcIntegration: "not-verified" });
  expect(worked.json.compactArgv).toEqual([
    "C:\\Windows\\System32\\compact.exe",
    "/C",
    "/EXE:XPRESS8K",
    `/S:D:\\SkladTest\\${id}`,
  ]);
  const dest = path.join(pool, id);
  expect((await stat(path.join(dest, "data.bin"))).size).toBeGreaterThan(0);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { kind: string; state: string; verified: boolean }[] };
  expect(jobs.jobs).toEqual([expect.objectContaining({ kind: "copy", state: "done", verified: true })]);

  process.env.SKLAD_DATA_DIR = dir;
  const response = await GET(new Request("http://127.0.0.1/api/jobs"));
  const body = await response.json() as { games: { id: string; ready: boolean }[]; jobs: unknown[] };
  expect(body.games.map((game) => game.id)).toContain(id);
  expect(body.jobs).toHaveLength(1);
  const { getProgressPayload } = await import("@/lib/progress/jobs");
  const progress = await getProgressPayload();
  expect(progress.games.some((game) => game.id === id)).toBe(true);
  expect(progress.jobs.some((job) => job.id === String((prepared.json as { jobId?: string }).jobId) && job.status === "completed")).toBe(true);

  const launched = run(dir, ["game", "launch", "--id", id]);
  expect(launched.json).toMatchObject({ launched: true, cleaned: false, moved: false });
  expect(await readFile(path.join(dest, "launched.txt"), "utf8")).toBe("ok\n");
  expect((await stat(source)).isDirectory()).toBe(true);
  const blockedRemove = run(dir, ["game", "remove", "--id", id]);
  expect(blockedRemove.status).toBe(3);
  expect(String(blockedRemove.json.error)).toMatch(/манифест|файл/);
  await rm(path.join(dest, "launched.txt"));
  const removed = run(dir, ["game", "remove", "--id", id]);
  expect(removed.json).toMatchObject({ removed: true, sourceKept: true, ready: false });
  await expect(stat(dest)).rejects.toThrow();
  expect((await stat(source)).isDirectory()).toBe(true);
});

it("blocks offline, E and Z, overlap, symlink, mutation, space pressure, and an unmanaged folder", async () => {
  const dir = await scratch();
  const pool = path.join(dir, "pool");
  await mkdir(pool);
  const missing = path.join(dir, "gone");
  const offline = run(dir, ["game", "register", "--root", missing, "--pool", pool, "--name", "Away", "--exe", "play.mjs", "--steam", "424242"]);
  expect(offline.json.game).toMatchObject({ online: false, ready: false });
  const offlineId = String((offline.json.game as { id: string }).id);
  const prepareOffline = run(dir, ["game", "prepare", "--id", offlineId]);
  expect(prepareOffline.status).toBe(3);
  expect(String(prepareOffline.json.error)).toMatch(/offline/);

  const forbidden = run(dir, ["game", "register", "--root", "E:\\Games\\A", "--pool", pool, "--name", "A", "--exe", "play.mjs", "--steam", "1"]);
  expect(forbidden.status).not.toBe(0);
  expect(String(forbidden.json.error)).toMatch(/E и Z/);
  expect(run(dir, ["game", "register", "--root", "Z:\\A", "--pool", pool, "--name", "Zed", "--exe", "a", "--steam", "1"]).status).not.toBe(0);

  const source = await gameDir(dir, "Overlap", 424242);
  expect(run(dir, ["game", "register", "--root", source, "--pool", source]).status).toBe(3);

  const linked = await gameDir(dir, "Link", 424242);
  await symlink("/etc/hostname", path.join(linked, "outside"));
  const linkReg = run(dir, ["game", "register", "--root", linked, "--pool", pool]);
  const linkId = String((linkReg.json.game as { id: string }).id);
  const linkPrepare = run(dir, ["game", "prepare", "--id", linkId]);
  expect(linkPrepare.status).toBe(3);
  expect(String(linkPrepare.json.error)).toMatch(/symlink|junction/);
  await expect(stat(path.join(pool, linkId))).rejects.toThrow();

  const mutable = await gameDir(dir, "Mut", 424242);
  const mutReg = run(dir, ["game", "register", "--root", mutable, "--pool", pool]);
  const mutId = String((mutReg.json.game as { id: string }).id);
  expect(run(dir, ["game", "prepare", "--id", mutId]).status).toBe(0);
  const mutated = run(dir, ["game", "work", "--compact-db", await compactDb(dir)], { SKLAD_GAME_MUTATE_SOURCE: "1" });
  expect(mutated.json.ready).not.toBe(true);
  await expect(stat(path.join(pool, mutId))).rejects.toThrow();

  const tight = await gameDir(dir, "Tight", 424242);
  const tightReg = run(dir, ["game", "register", "--root", tight, "--pool", pool]);
  const tightId = String((tightReg.json.game as { id: string }).id);
  const pressure = run(dir, ["game", "prepare", "--id", tightId], { SKLAD_GAME_FREE_BYTES: "1" });
  expect(pressure.status).toBe(3);
  expect(pressure.json.victim).toBeNull();
  expect((await readFile(path.join(dir, "library.json"), "utf8"))).toContain(tightId);
  await expect(stat(path.join(pool, tightId))).rejects.toThrow();

  const owned = await gameDir(dir, "Owned", 424242);
  const ownedReg = run(dir, ["game", "register", "--root", owned, "--pool", pool]);
  const ownedId = String((ownedReg.json.game as { id: string }).id);
  await mkdir(path.join(pool, ownedId));
  await writeFile(path.join(pool, ownedId, "user-save.txt"), "keep");
  const unmanaged = run(dir, ["game", "prepare", "--id", ownedId]);
  expect(unmanaged.status).toBe(3);
  expect(await readFile(path.join(pool, ownedId, "user-save.txt"), "utf8")).toBe("keep");
  expect(coldGameBlocksDelete([{ root: owned }], path.join(owned, "data.bin"))).toBe(true);
});

it("does not leave a ready copy after cancel or a crash, then finishes the same job", async () => {
  const dir = await scratch();
  const pool = path.join(dir, "pool");
  await mkdir(pool);
  const source = await gameDir(dir, "Crash", 424242);
  const db = await compactDb(dir);
  const id = String((run(dir, ["game", "register", "--root", source, "--pool", pool]).json.game as { id: string }).id);
  expect(run(dir, ["game", "prepare", "--id", id]).status).toBe(0);
  const cancelled = run(dir, ["game", "cancel", "--id", id]);
  expect(cancelled.json.ready).toBe(false);
  expect(run(dir, ["game", "work", "--compact-db", db]).json.processed).toBe(false);
  await expect(stat(path.join(pool, id))).rejects.toThrow();

  expect(run(dir, ["game", "prepare", "--id", id]).status).toBe(0);
  expect(run(dir, ["game", "work", "--compact-db", db], { SKLAD_GAME_EXIT: "86" }).status).toBe(86);
  await expect(stat(path.join(pool, id))).rejects.toThrow();
  const recovered = run(dir, ["game", "work", "--compact-db", db]);
  expect(recovered.json).toMatchObject({ verified: true, ready: true, compressed: false });
  expect((await stat(path.join(pool, id, "data.bin"))).isFile()).toBe(true);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
  expect(jobs.jobs).toHaveLength(1);
});

it("refuses launch when the database says compression is worthwhile and this host cannot compact", async () => {
  const dir = await scratch();
  const pool = path.join(dir, "pool");
  await mkdir(pool);
  const source = await gameDir(dir, "Big", 424243);
  const db = await compactDb(dir);
  const id = String((run(dir, ["game", "register", "--root", source, "--pool", pool]).json.game as { id: string }).id);
  expect(run(dir, ["game", "prepare", "--id", id]).status).toBe(0);
  const worked = run(dir, ["game", "work", "--compact-db", db]);
  expect(worked.json).toMatchObject({ verified: true, ready: false, compressed: false, compact: "blocked", pcIntegration: "not-verified", executed: false });
  expect(run(dir, ["game", "launch", "--id", id]).status).toBe(3);
  await writeFile(path.join(pool, id, "saves", "slot.txt"), "changed");
  expect(run(dir, ["game", "remove", "--id", id]).status).toBe(3);
  expect((await stat(path.join(pool, id, "saves", "slot.txt"))).isFile()).toBe(true);
  expect((await stat(source)).isDirectory()).toBe(true);
});

it("rejects a folder that is only an exe name", async () => {
  const dir = await scratch();
  const pool = path.join(dir, "pool");
  const source = path.join(dir, "only-exe");
  await mkdir(pool);
  await mkdir(source);
  await writeFile(path.join(source, "play.mjs"), "#!/usr/bin/env node\n");
  const refused = run(dir, ["game", "register", "--root", source, "--pool", pool]);
  expect(refused.status).toBe(3);
  expect(String(refused.json.error)).toMatch(/exe|папк/);
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-game-"));
  dirs.push(dir);
  return dir;
}

async function gameDir(dir: string, name: string, steam: number): Promise<string> {
  const source = path.join(dir, name);
  await mkdir(path.join(source, "saves"), { recursive: true });
  await writeFile(path.join(source, "data.bin"), "payload-bytes");
  await writeFile(path.join(source, "saves", "slot.txt"), "1");
  const exe = path.join(source, "play.mjs");
  await writeFile(exe, "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./launched.txt', import.meta.url), 'ok\\n');\n");
  await chmod(exe, 0o755);
  await writeFile(path.join(source, "sklad-game.json"), JSON.stringify({
    name,
    steamAppId: steam,
    exe: "play.mjs",
    args: [],
    saves: ["saves/slot.txt"],
  }));
  return source;
}

async function compactDb(dir: string): Promise<string> {
  const file = path.join(dir, "compact.json");
  await writeFile(file, JSON.stringify([
    { SteamID: 424242, GameName: "Fixture", FolderName: "Fixture", Confidence: 2, CompressionResults: [{ CompType: 1, BeforeBytes: 1000, AfterBytes: 950, TotalResults: 2 }], TotalFiles: 1 },
    { SteamID: 424243, GameName: "Big", FolderName: "Big", Confidence: 2, CompressionResults: [{ CompType: 1, BeforeBytes: 1000, AfterBytes: 400, TotalResults: 4 }], TotalFiles: 1 },
  ]));
  return file;
}
