import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

import { candidatesFromIndex } from "@/lib/games/discover";

const root = process.cwd();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("imports Steam, Epic and GOG manifests from one configured root and keeps a non-Steam game unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-discover-"));
  dirs.push(dir);
  const library = path.join(dir, "library");
  await mkdir(path.join(library, "steamapps", "common", "Fixture"), { recursive: true });
  await writeFile(path.join(library, "steamapps", "appmanifest_424242.acf"), `"AppState"\n{\n"appid" "424242"\n"name" "Fixture"\n"installdir" "Fixture"\n}\n`);
  await mkdir(path.join(library, "epic"), { recursive: true });
  await writeFile(path.join(library, "epic", "Manifest_fixture.item"), JSON.stringify({ DisplayName: "Epic Fixture", InstallLocation: path.join(library, "epic", "Fixture") }));
  await mkdir(path.join(library, "gog"), { recursive: true });
  await writeFile(path.join(library, "gog", "goggame-1.info"), JSON.stringify({ name: "GOG Fixture", gameId: "1", playTasks: [{ category: "game", path: "play.mjs" }] }));
  const result = spawnSync(process.execPath, ["--import", "./agents/register.mjs", "agents/sklad.mts", "game", "discover", "--root", library, "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0" },
    encoding: "utf8",
  });
  const json = JSON.parse((result.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}") as { ok: boolean; added: number; copied: boolean; games: { name: string; steamAppId: number | null; provenance: string; needsReview: boolean; compact: string }[] };
  expect(result.status).toBe(0);
  expect(json.copied).toBe(false);
  expect(json.added).toBe(3);
  expect(json.games).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Fixture", steamAppId: 424242, provenance: "steam-manifest", needsReview: false }),
    expect.objectContaining({ name: "Epic Fixture", steamAppId: null, provenance: "epic-manifest", needsReview: true, compact: "unknown" }),
    expect.objectContaining({ name: "GOG Fixture", steamAppId: null, provenance: "gog-manifest", compact: "unknown" }),
  ]));
  const again = spawnSync(process.execPath, ["--import", "./agents/register.mjs", "agents/sklad.mts", "game", "discover", "--root", library, "--json"], {
    cwd: root,
    env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_JOB_WORKERS: "0" },
    encoding: "utf8",
  });
  const second = JSON.parse((again.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "{}") as { added: number; existing: number };
  expect(second.added).toBe(0);
  expect(second.existing).toBe(3);
  const stored = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8")) as { games: { unmanaged: boolean; root: string }[] };
  expect(stored.games).toHaveLength(3);
  expect(stored.games.every((game) => game.unmanaged === false)).toBe(true);
});

it("turns an offline index path into a review candidate and skips E: without reading it", () => {
  const found = candidatesFromIndex([
    "D:\\Steam\\steamapps\\appmanifest_10.acf",
    "C:\\Steam\\steamapps\\appmanifest_20.acf",
    "E:\\Steam\\steamapps\\appmanifest_30.acf",
    "Z:\\Games\\appmanifest_40.acf",
  ]);
  expect(found.map((item) => item.steamAppId)).toEqual([10, 20]);
  expect(found.find((item) => item.steamAppId === 20)?.unmanaged).toBe(true);
  expect(found.every((item) => item.provenance === "offline-index" && item.needsReview && item.confidence === "low")).toBe(true);
});
