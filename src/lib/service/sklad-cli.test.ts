import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const root = process.cwd();
const node = process.execPath;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(dir: string, args: string[], extra: Record<string, string> = {}): { status: number; json: Record<string, unknown> } {
  const result = spawnSync(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", ...args, "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0", ...extra },
    encoding: "utf8",
  });
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}";
  return { status: result.status ?? 1, json: JSON.parse(line) as Record<string, unknown> };
}

it("runs snapshot ingest, one verify job, restart, and a repeated ingest without duplicates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-cli-"));
  dirs.push(dir);
  const fixture = path.join(root, "fixtures/sklad-snapshot-v1.json");
  const ingested = run(dir, ["ingest", "--fixture", fixture]);
  expect(ingested.status).toBe(0);
  expect(ingested.json.ok).toBe(true);
  expect(ingested.json.wiztree).toBe(false);
  expect(ingested.json.files).toBe(1);
  const diskId = String(ingested.json.diskId);

  const catalog = run(dir, ["catalog"]);
  expect(catalog.json.scanned).toBe(false);
  expect(catalog.json.disks).toEqual([expect.objectContaining({ id: diskId, files: 1, online: false })]);

  const crashed = run(dir, ["work", "--once"], { SKLAD_CRASH_AFTER_CLAIM: "1" });
  expect(crashed.status).toBe(86);
  const resumed = run(dir, ["work", "--once"]);
  expect(resumed.status).toBe(0);
  expect(resumed.json).toMatchObject({ processed: true, state: "done", verified: true });
  const receipt = JSON.parse(await readFile(path.join(dir, "receipts", `${diskId}.json`), "utf8")) as { verified?: boolean; files?: number };
  expect(receipt).toMatchObject({ verified: true, files: 2 });

  const again = run(dir, ["ingest", "--fixture", fixture]);
  expect(again.json.jobCreated).toBe(false);
  expect(again.json.diskId).toBe(diskId);
  const idle = run(dir, ["work", "--once"]);
  expect(idle.json.processed).toBe(false);
  const status = run(dir, ["status"]);
  expect(status.json.jobs).toHaveLength(1);
  expect((status.json.counts as { done?: number }).done).toBe(1);

  const drives = JSON.parse(await readFile(path.join(dir, "drives.json"), "utf8")) as { disks: { id: string }[] };
  expect(drives.disks).toHaveLength(1);

  const rejected = run(dir, ["ingest", "--fixture", path.join(dir, "missing.MFT")]);
  expect(rejected.status).toBe(3);
  expect(rejected.json.wiztree).toBe(false);

  const policy = run(dir, ["policy"]);
  expect(policy.json.pin).toBe("until-explicit-remove");
  expect((policy.json.encode as { started?: boolean }).started).toBe(false);
  expect(run(dir, ["encode"]).status).toBe(2);
});

it("starts and stops the service process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-service-"));
  dirs.push(dir);
  const started = run(dir, ["service", "start"]);
  expect(started.status).toBe(0);
  expect(started.json.pid).toEqual(expect.any(Number));
  const running = run(dir, ["service", "status"]);
  expect(running.json.running).toBe(true);
  const stopped = run(dir, ["service", "stop"]);
  expect(stopped.status).toBe(0);
  expect(run(dir, ["service", "status"]).json.running).toBe(false);
});

it("fails verification when the stored snapshot no longer matches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-cli-bad-"));
  dirs.push(dir);
  const fixture = path.join(root, "fixtures/sklad-snapshot-v1.json");
  const ingested = run(dir, ["ingest", "--fixture", fixture]);
  const diskId = String(ingested.json.diskId);
  const catalogPath = path.join(dir, "drives.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { disks: { id: string; files: { size: number }[] }[] };
  const disk = catalog.disks.find((item) => item.id === diskId);
  expect(disk).toBeTruthy();
  disk!.files[1]!.size = 9;
  await writeFile(catalogPath, JSON.stringify(catalog));
  const checked = run(dir, ["work", "--once"]);
  expect(checked.json.verified).toBe(false);
  expect(String(checked.json.error)).toMatch(/не совпала/);
});

it("two workers do not both verify the same job", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-cli-race-"));
  dirs.push(dir);
  expect(run(dir, ["ingest", "--fixture", path.join(root, "fixtures/sklad-snapshot-v1.json")]).status).toBe(0);
  await Promise.all([once(dir), once(dir)]);
  const status = run(dir, ["status"]);
  expect(status.json.jobs).toHaveLength(1);
  expect((status.json.counts as { done?: number }).done).toBe(1);
});

function once(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ["--import", "./agents/register.mjs", "agents/sklad.mts", "work", "--once", "--json"], {
      cwd: root,
      env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0" },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`work exit ${code}`))));
    child.on("error", reject);
  });
}
