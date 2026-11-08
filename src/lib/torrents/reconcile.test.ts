import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createJobStore } from "@/lib/jobs/engine";
import { reconcileProtocol, runTorrentOnce, type ProtocolSnapshot, type TorrentRule } from "@/lib/torrents/reconcile";

const HOUR = 3600;
const root = process.cwd();
const dirs: string[] = [];
const hashA = "a".repeat(40);
const hashB = "b".repeat(40);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => {
    spawnSync(process.execPath, ["--import", "./agents/register.mjs", "agents/sklad.mts", "service", "stop", "--json"], {
      cwd: root,
      env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0" },
      encoding: "utf8",
    });
    await rm(dir, { recursive: true, force: true });
  }));
});

it("keeps one completion job, remembers the client date, and retains the source until a smaller output exists", async () => {
  const dir = await scratch();
  const { source, rules } = await layout(dir);
  const completedAt = 1_700_000_000;
  const first = await reconcileProtocol(dir, protocol(source, { hash: hashA, progress: 1, ratio: 3, downloaded: 4, completionOn: completedAt, addedOn: 10 }), rules, completedAt + 10);
  expect(first.enqueued).toBe(1);
  const second = await reconcileProtocol(dir, protocol(source, { hash: hashA, progress: 1, ratio: 3, downloaded: 4, completionOn: completedAt + 999, addedOn: 1 }), rules, completedAt + 50);
  expect(second.enqueued).toBe(0);
  const memory = JSON.parse(await readFile(path.join(dir, "torrent-completion.json"), "utf8")) as Record<string, { completedAt: number }>;
  expect(memory[hashA]?.completedAt).toBe(completedAt);
  const verified = await runTorrentOnce(dir, completedAt + 50);
  expect(verified).toMatchObject({ processed: true, verified: true, deleted: false, eligible: true });
  expect((await stat(path.join(source, "a.bin"))).isFile()).toBe(true);
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
  expect(jobs.jobs).toHaveLength(1);
});

it("retains below the gate, passes on ratio or 72h, and blocks an unknown date unless ratio is known", async () => {
  const dir = await scratch();
  const { source, rules } = await layout(dir);
  const completedAt = 1_700_000_000;
  await reconcileProtocol(dir, protocol(source, { hash: hashA, progress: 1, ratio: 2, downloaded: 4, completionOn: completedAt }), rules, completedAt + 10);
  await runTorrentOnce(dir, completedAt + 10);
  expect((await journal(dir, hashA)).gate).toBe("none");
  expect((await journal(dir, hashA)).deleted).toBe(false);

  await reconcileProtocol(dir, protocol(source, { hash: hashA, progress: 1, ratio: 3, downloaded: 4, completionOn: completedAt }), rules, completedAt + 20);
  await rerun(dir, completedAt + 20);
  expect((await journal(dir, hashA)).gate).toBe("ratio");

  await reconcileProtocol(dir, protocol(source, { hash: hashA, progress: 1, ratio: 2, downloaded: 4, completionOn: completedAt, state: "paused" }), rules, completedAt + 72 * HOUR);
  await rerun(dir, completedAt + 72 * HOUR);
  expect((await journal(dir, hashA)).gate).toBe("time");

  const bare = await scratch();
  const bareLayout = await layout(bare);
  await reconcileProtocol(bare, protocol(bareLayout.source, { hash: hashA, progress: 1, ratio: null, downloaded: null, completionOn: 0, addedOn: 5 }), bareLayout.rules, 9_000);
  expect(JSON.parse(await readFile(path.join(bare, "torrent-notes.json"), "utf8")).notes[0].action).toBe("queued");
  await runTorrentOnce(bare, 9_000);
  expect((await journal(bare, hashA)).eligible).toBe(false);
  const withRatio = await scratch();
  const ratioLayout = await layout(withRatio);
  await reconcileProtocol(withRatio, protocol(ratioLayout.source, { hash: hashA, progress: 1, ratio: 3, downloaded: 4, completionOn: 0, addedOn: 5 }), ratioLayout.rules, 9_000);
  await runTorrentOnce(withRatio, 9_000);
  expect((await journal(withRatio, hashA)).gate).toBe("ratio");
});

it("blocks a partial torrent, a shared file, a corrupt copy, and E:", async () => {
  const dir = await scratch();
  const { source, rules } = await layout(dir);
  const partial = await reconcileProtocol(dir, protocol(source, {
    hash: hashA,
    progress: 1,
    ratio: 4,
    downloaded: 4,
    completionOn: 100,
    files: [{ name: "a.bin", size: 4, progress: 1 }, { name: "b.bin", size: 4, progress: 0.2 }],
  }), rules, 200);
  expect(partial).toMatchObject({ enqueued: 0, blocked: 1 });

  const sharedDir = await scratch();
  const shared = await layout(sharedDir);
  const snap = protocol(shared.source, { hash: hashA, progress: 1, ratio: 4, downloaded: 4, completionOn: 100 });
  snap.torrents.push({ ...snap.torrents[0]!, hash: hashB, ratio: 0.2, downloaded: 4 });
  await reconcileProtocol(sharedDir, snap, shared.rules, 200);
  await runTorrentOnce(sharedDir, 200);
  expect((await journal(sharedDir, hashA)).deleted).toBe(false);
  expect((await stat(path.join(shared.source, "a.bin"))).isFile()).toBe(true);

  const corruptDir = await scratch();
  const corrupt = await layout(corruptDir);
  await reconcileProtocol(corruptDir, protocol(corrupt.source, { hash: hashA, progress: 1, ratio: 4, downloaded: 4, completionOn: 100 }), corrupt.rules, 200);
  await runTorrentOnce(corruptDir, 200);
  const dest = path.join(corrupt.rules[0]!.outputRoot, hashA);
  await writeFile(dest, "nope");
  await createJobStore(corruptDir).requeueCopy(JSON.parse(await readFile(path.join(corruptDir, "jobs.json"), "utf8")).jobs[0].id);
  const again = await runTorrentOnce(corruptDir, 200);
  expect(again.verified).toBe(false);
  expect((await stat(path.join(corrupt.source, "a.bin"))).isFile()).toBe(true);

  const closed = await reconcileProtocol(dir, protocol(source, { hash: hashB, progress: 1, ratio: 4, downloaded: 4, completionOn: 100, savePath: "E:\\Archive" }), rules, 200);
  expect(closed.blocked).toBe(1);
  expect(closed.enqueued).toBe(0);
});

it("lets the running service enqueue and verify one local completion without a manual work command", async () => {
  const dir = await scratch();
  const { source, rules } = await layout(dir);
  await writeFile(path.join(dir, "torrent-rules.json"), JSON.stringify({ rules }));
  const env = { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", SKLAD_SERVICE_TICK_MS: "40" };
  expect(run(env, ["service", "start"]).status).toBe(0);
  await writeFile(path.join(dir, "torrent-local.json"), JSON.stringify(protocol(source, { hash: hashA, progress: 1, ratio: 3, downloaded: 4, completionOn: 1_700_000_000 })));
  const seen = await waitJob(dir);
  expect(seen.jobs).toHaveLength(1);
  expect(seen.jobs[0]).toMatchObject({ state: "done", verified: true });
  expect((await stat(path.join(source, "a.bin"))).isFile()).toBe(true);
  expect(run(env, ["service", "stop"]).status).toBe(0);
  expect(run(env, ["service", "start"]).status).toBe(0);
  await delay(500);
  const after = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string }[] };
  expect(after.jobs.map((job) => job.id)).toEqual(seen.jobs.map((job) => job.id));
  expect(run(env, ["service", "stop"]).status).toBe(0);
}, 40_000);

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-torrent-"));
  dirs.push(dir);
  return dir;
}

async function layout(dir: string): Promise<{ source: string; rules: TorrentRule[] }> {
  const source = path.join(dir, "incoming");
  const output = path.join(dir, "verified");
  await writeFile(path.join(source, "a.bin"), "data").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "a.bin"), "data");
  });
  return { source, rules: [{ id: "media", savePrefix: source, outputRoot: output, managedRoot: source, retire: true }] };
}

function protocol(source: string, patch: Partial<ProtocolSnapshot["torrents"][number]> & { hash: string }): ProtocolSnapshot {
  return {
    hostId: "local",
    os: "darwin",
    torrents: [{
      hash: patch.hash,
      name: "clip",
      progress: patch.progress ?? 1,
      state: patch.state ?? "seeding",
      ratio: patch.ratio === undefined ? 1 : patch.ratio,
      downloaded: patch.downloaded === undefined ? 4 : patch.downloaded,
      uploaded: 0,
      addedOn: patch.addedOn ?? 10,
      completionOn: patch.completionOn ?? 0,
      savePath: patch.savePath ?? source,
      files: patch.files ?? [{ name: "a.bin", size: 4, progress: 1 }],
    }],
  };
}

async function rerun(dir: string, now: number): Promise<void> {
  const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string }[] };
  await createJobStore(dir).requeueCopy(jobs.jobs[0]!.id);
  await runTorrentOnce(dir, now);
}

async function journal(dir: string, hash: string): Promise<{ gate?: string; deleted?: boolean; eligible?: boolean }> {
  return JSON.parse(await readFile(path.join(dir, "torrent-journal", `${hash}.json`), "utf8")) as { gate?: string; deleted?: boolean; eligible?: boolean };
}

async function waitJob(dir: string): Promise<{ jobs: { id: string; state: string; verified: boolean }[] }> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { id: string; state: string; verified: boolean }[] };
      if (parsed.jobs.some((job) => job.state === "done" && job.verified)) return parsed;
    } catch {
      /* not written yet */
    }
    await delay(100);
  }
  throw new Error("Служба не проверила раздачу.");
}

function run(env: NodeJS.ProcessEnv, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args, "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}";
  return { status: result.status ?? 1, json: JSON.parse(line) as Record<string, unknown> };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
