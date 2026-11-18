import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { encodeMftFixture } from "@/addons/media-games/file-index/mft";
import { encodeUsnJournal, encodeUsnRecord, UsnReason } from "@/addons/media-games/file-index/usn";
import { GET, POST } from "@/app/api/windows-library/route";
import { AppError } from "@/lib/app-error";
import { evictPreparedGame } from "@/lib/policies/storage-roles";
import { dispatchOnce } from "@/lib/service/dispatch";
import { applyLibraryCommand, handleLibraryCommand } from "@/lib/windows-library/adapter";
import { moveSteamApp, retargetAppManifest } from "@/lib/windows-library/launchers";
import { moveRequest } from "@/lib/windows-library/screen-actions";
import { emptyLibraryState, saveLibraryState } from "@/lib/windows-library/store";
import { encodeReadUsnJournal, encodeUsnJournalData, FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, parseUsnJournalData, usnJournalLost } from "@/lib/windows-library/usn-journal";
import type { VolumeIdentity } from "@/lib/windows-library/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const disk: VolumeIdentity = {
  serial: "WD-1",
  uuid: "60366b36-c743-4523-84fd-57b2aa95efda",
  os: "win32",
  filesystem: "ntfs",
  letter: "D",
  mount: "D:\\",
};

it("refuses a timer poll and reads MFT once, then only the USN journal", () => {
  const state = emptyLibraryState();
  const poll = applyLibraryCommand(state, { action: "event", event: { type: "poll" } }) as { actions: { type: string; reason: string }[] };
  expect(poll.actions[0]).toMatchObject({ type: "refuse" });
  expect(poll.actions[0]?.reason).toMatch(/таймер/);

  const arrival = applyLibraryCommand(state, { action: "event", event: { type: "wmi", eventType: 2, identity: disk } }) as { actions: { type: string }[] };
  expect(arrival.actions.map((item) => item.type)).toEqual(["read-mft"]);
  applyLibraryCommand(state, {
    action: "mft",
    serial: disk.serial,
    uuid: disk.uuid,
    fixtureBase64: steamFixture().toString("base64"),
    texts: [{ relativePath: "Steam/steamapps/appmanifest_424242.acf", text: manifestText() }],
  });
  expect(() => applyLibraryCommand(state, { action: "mft", serial: disk.serial, uuid: disk.uuid, fixtureBase64: steamFixture().toString("base64") })).toThrow(/Повторное чтение/);
  const again = applyLibraryCommand(state, { action: "event", event: { type: "wmi", eventType: 2, identity: disk } }) as { actions: { type: string; ioctl?: number }[] };
  expect(again.actions[0]).toMatchObject({ type: "query-usn", ioctl: FSCTL_QUERY_USN_JOURNAL });
  const game = state.games[0];
  expect(game?.title).toBe("Fixture");
  expect(game?.steamAppId).toBe(424242);
  expect(game?.logicalBytes).toBe(100);
  expect(game?.serial).toBe("WD-1");
  expect(game?.cover.source).toBe("steam-app");
  expect(game?.cover.url).toContain("/424242/");
  expect(game?.pool).toBe("archive");
});

it("walks exFAT once and does not walk it again", () => {
  const state = emptyLibraryState();
  const fat = { ...disk, filesystem: "exfat" as const, serial: "FAT-1" };
  const first = applyLibraryCommand(state, { action: "event", event: { type: "dbt", code: 0x8000, identity: fat } }) as { actions: { type: string; reason: string }[] };
  expect(first.actions[0]).toMatchObject({ type: "walk-once", reason: "fat" });
  applyLibraryCommand(state, {
    action: "walk",
    serial: fat.serial,
    uuid: fat.uuid,
    entries: [
      { relativePath: "Games/Hades", name: "Hades", isDirectory: true, logicalBytes: null, allocatedBytes: null, compressed: null, algorithm: null },
      { relativePath: "Games/Hades/Hades.exe", name: "Hades.exe", isDirectory: false, logicalBytes: 40, allocatedBytes: 40, compressed: false, algorithm: null },
    ],
  });
  expect(state.games.map((game) => game.title)).toEqual(["Hades"]);
  expect(state.games[0]?.compression).toBe("uncompressed");
  const second = applyLibraryCommand(state, { action: "event", event: { type: "dbt", code: 0x8000, identity: fat } }) as { actions: { type: string; reason: string }[] };
  expect(second.actions[0]?.type).toBe("ignore");
  expect(() => applyLibraryCommand(state, { action: "walk", serial: fat.serial, uuid: fat.uuid, entries: [] })).toThrow(AppError);
});

it("treats a replaced USN journal as one resync walk and keeps a Mac diskutil cache", () => {
  expect(usnJournalLost({ journalId: "7", nextUsn: "100" }, { journalId: "8", lowestValidUsn: "1", nextUsn: "200" })).toBe(true);
  expect(usnJournalLost({ journalId: "7", nextUsn: "100" }, { journalId: "7", lowestValidUsn: "101", nextUsn: "200" })).toBe(true);
  expect(FSCTL_READ_USN_JOURNAL).toBe(0x900bb);
  const parsed = parseUsnJournalData(encodeUsnJournalData({ journalId: 7n, firstUsn: 1n, nextUsn: 120n, lowestValidUsn: 50n, maxUsn: 1000n, maximumSize: 10n, allocationDelta: 1n }));
  expect(parsed.nextUsn).toBe(120n);
  const request = encodeReadUsnJournal({ startUsn: 100n, journalId: 7n });
  expect(request.readBigInt64LE(0)).toBe(100n);
  expect(request.readUInt32LE(12)).toBe(1);

  const state = emptyLibraryState();
  applyLibraryCommand(state, { action: "event", event: { type: "wmi", eventType: 2, identity: disk } });
  applyLibraryCommand(state, { action: "mft", serial: disk.serial, uuid: disk.uuid, fixtureBase64: steamFixture().toString("base64"), texts: [{ relativePath: "Steam/steamapps/appmanifest_424242.acf", text: manifestText() }] });
  applyLibraryCommand(state, { action: "event", event: { type: "journal-info", identity: disk, journalId: "7", lowestValidUsn: "1", nextUsn: "100" } });
  const lost = applyLibraryCommand(state, { action: "event", event: { type: "journal-info", identity: disk, journalId: "9", lowestValidUsn: "1", nextUsn: "4" } }) as { actions: { type: string; reason: string }[] };
  expect(lost.actions[0]).toMatchObject({ type: "walk-once", reason: "journal-lost" });
  const repeat = applyLibraryCommand(state, { action: "event", event: { type: "journal-info", identity: disk, journalId: "9", lowestValidUsn: "1", nextUsn: "4" } }) as { actions: { reason: string }[] };
  expect(repeat.actions[0]?.reason).toMatch(/уже назначен/);

  const mac = { ...disk, os: "darwin" as const, filesystem: "apfs" as const, letter: null, mount: "/Volumes/Games", serial: "MAC-1" };
  const appear = applyLibraryCommand(state, { action: "event", event: { type: "mac-appear", identity: mac } }) as { actions: { type: string }[] };
  expect(appear.actions.map((item) => item.type)).toEqual(["diskutil-info-once", "walk-once"]);
  applyLibraryCommand(state, { action: "diskutil-cached", serial: mac.serial, uuid: mac.uuid });
  applyLibraryCommand(state, { action: "walk", serial: mac.serial, uuid: mac.uuid, entries: [] });
  const later = applyLibraryCommand(state, { action: "event", event: { type: "mac-appear", identity: mac } }) as { actions: { type: string; reason: string }[] };
  expect(later.actions[0]?.reason).toMatch(/diskutil info повторно не вызывается/);
  const history = applyLibraryCommand(state, { action: "event", event: { type: "fsevent", identity: mac, eventId: "4", historyDropped: true } }) as { actions: { reason: string }[] };
  expect(history.actions[0]).toMatchObject({ type: "walk-once", reason: "history-dropped" });
  const forbidden = applyLibraryCommand(state, { action: "event", event: { type: "wmi", eventType: 2, identity: { ...disk, letter: "E", serial: "E-1" } } }) as { actions: { type: string }[] };
  expect(forbidden.actions[0]?.type).toBe("refuse");
});

it("applies a USN create without rereading the MFT", () => {
  const state = emptyLibraryState();
  applyLibraryCommand(state, { action: "event", event: { type: "wmi", eventType: 2, identity: disk } });
  applyLibraryCommand(state, { action: "mft", serial: disk.serial, uuid: disk.uuid, fixtureBase64: steamFixture().toString("base64"), texts: [{ relativePath: "Steam/steamapps/appmanifest_424242.acf", text: manifestText() }] });
  applyLibraryCommand(state, { action: "event", event: { type: "journal-info", identity: disk, journalId: "7", lowestValidUsn: "1", nextUsn: "100" } });
  applyLibraryCommand(state, { action: "event", event: { type: "journal-info", identity: disk, journalId: "7", lowestValidUsn: "1", nextUsn: "130" } });
  const header = Buffer.alloc(8);
  header.writeBigInt64LE(130n, 0);
  const record = encodeUsnRecord({ fileRef: 20n, parentRef: 13n, usn: 120n, reason: UsnReason.FILE_CREATE | UsnReason.CLOSE, name: "Extra.exe" });
  const applied = applyLibraryCommand(state, { action: "usn", serial: disk.serial, uuid: disk.uuid, journalBase64: Buffer.concat([header, encodeUsnJournal([record])]).toString("base64") }) as { unplaced: number };
  expect(applied.unplaced).toBe(0);
  expect(state.games[0]?.logicalBytes).toBeNull();
  expect(state.jobs).toEqual([]);
});

it("rewrites a Steam library entry without asking Steam to download the game again", () => {
  const moved = moveSteamApp(`"libraryfolders"\n{\n"0"\n{\n"path"\t\t"D:\\\\Steam"\n"apps"\n{\n"424242"\t\t"100"\n}\n}\n}\n`, "D:\\Steam", "S:\\Fast", "424242", 100);
  expect(moved.match(/424242/g)).toHaveLength(1);
  const manifest = retargetAppManifest(manifestText(), 100);
  expect(manifest).toContain('"BytesToDownload"\t\t"0"');
  expect(manifest).toContain('"FullValidateAfterNextUpdate"\t\t"0"');
});

it("keeps the designer games screen on the live API and out of the demo list", async () => {
  const live = await readFile("public/prototype/library-live.js", "utf8");
  const seed = await readFile("public/prototype/demo-data.js", "utf8");
  const games = await readFile("public/prototype/games.js", "utf8");
  const app = await readFile("public/prototype/app.js", "utf8");
  expect(live).toContain("/api/windows-library");
  expect(live).toContain("confirm: true");
  expect(live).toContain("liveMoveConfirm");
  expect(live).not.toMatch(/setInterval\s*\(|diskutil/);
  expect(app).toContain("winLiveMove");
  expect(seed).toContain('location.hash === "#games"');
  expect(seed).toContain('get("demo") !== "1"');
  expect(games).toContain("s.liveLibrary");
  expect(games).toContain("liveMove");
  expect(games).toContain("globalThis.GameLibrary = GameLibrary");
  expect(games).toContain("Холодный архив на месте.");
  expect(live).toContain("Холодная копия на HDD остаётся");
  expect(live).not.toContain("Источник удаляется");
});

it("does not enqueue a move from the screen until the dialog is confirmed", () => {
  expect(moveRequest({ id: "wg-1", kind: "play", confirmed: false, notRunning: true }).ok).toBe(false);
  expect(moveRequest({ id: "wg-1", kind: "play", confirmed: true, notRunning: false }).ok).toBe(false);
  expect(moveRequest({ id: "wg-1", kind: "return", confirmed: true, notRunning: true })).toEqual({
    ok: true,
    body: { action: "return", id: "wg-1", confirm: true, processes: [] },
  });
});

it("serves an empty library and refuses to run a job inside the request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "winlib-"));
  dirs.push(dir);
  process.env.SKLAD_DATA_DIR = dir;
  const listed = await GET();
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { games: unknown[]; polling: boolean };
  expect(body.games).toEqual([]);
  expect(body.polling).toBe(false);
  const refused = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "advance" }) }));
  expect(refused.status).toBe(400);
  const saved = await readFile(path.join(dir, "windows-library.json"), "utf8").catch(() => "");
  expect(saved).not.toContain("Hades");
  delete process.env.SKLAD_DATA_DIR;
});

it("copies through the shared jobs queue, keeps the HDD source, and removes the pool copy only on an explicit command", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "winlib-play-"));
  dirs.push(dir);
  const source = await gameDir(dir);
  const pool = path.join(dir, "pool");
  await mkdir(pool);
  const db = await compactDb(dir);
  const state = emptyLibraryState();
  state.settings.fastSsd = { serial: "SSD-1", uuid: "ssd-uuid", root: pool };
  state.games = [
    {
      id: "wg-fixture",
      title: "Fixture",
      launcher: "folder",
      steamAppId: 424242,
      root: source,
      installdir: null,
      manifestPath: null,
      libraryFoldersPath: null,
      serial: "WD-1",
      uuid: disk.uuid,
      archiveRoot: source,
      archiveSerial: "WD-1",
      archiveUuid: disk.uuid,
      logicalBytes: 13,
      allocatedBytes: 13,
      compression: "uncompressed",
      algorithm: null,
      cover: { cacheKey: "fixture", source: "name", url: null, cached: false },
      pool: "archive",
      online: true,
    },
  ];
  await saveLibraryState(dir, state);
  const previousData = process.env.SKLAD_DATA_DIR;
  const previousDb = process.env.SKLAD_COMPACT_DB;
  process.env.SKLAD_DATA_DIR = dir;
  process.env.SKLAD_COMPACT_DB = db;
  try {
    const poolSource = await readFile("src/lib/windows-library/pool.ts", "utf8");
    expect(poolSource).not.toContain("delete-source");
    expect(poolSource).not.toContain("sourceRoot");

    const quiet = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "play", id: "wg-fixture", confirm: false, processes: [] }) }));
    expect(quiet.status).toBe(400);
    const running = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "play", id: "wg-fixture", confirm: true, processes: [{ path: path.join(source, "play.mjs") }] }) }));
    expect(running.status).toBe(409);
    await expect(stat(path.join(dir, "jobs.json"))).rejects.toThrow();

    const closed = emptyLibraryState();
    closed.settings.fastSsd = { serial: "SSD-1", uuid: "ssd-uuid", root: "F:\\Alcohol" };
    closed.games = [{ ...state.games[0]!, id: "wg-e", root: "E:\\Games\\Fixture", archiveRoot: "E:\\Games\\Fixture" }];
    await saveLibraryState(dir, closed);
    await expect(handleLibraryCommand({ action: "play", id: "wg-e", confirm: true, processes: [] }, dir)).rejects.toThrow(/E:/);
    closed.games = [{ ...state.games[0]!, id: "wg-e", root: source, archiveRoot: source }];
    await saveLibraryState(dir, closed);
    await expect(handleLibraryCommand({ action: "play", id: "wg-e", confirm: true, processes: [] }, dir)).rejects.toThrow(/Alcohol/);
    await saveLibraryState(dir, state);
    await expect(stat(path.join(dir, "jobs.json"))).rejects.toThrow();

  const played = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "play", id: "wg-fixture", confirm: true, processes: [] }) }));
  expect(played.status).toBe(200);
  const first = (await played.json()) as { created: boolean; sourceDeleted: boolean; library: { games: { pool: string; job: { sourceDeleted: boolean; state: string } | null }[] } };
  expect(first.created).toBe(true);
  expect(first.sourceDeleted).toBe(false);
  expect(first.library.games[0]?.pool).toBe("archive");
  expect(first.library.games[0]?.job).toMatchObject({ state: "queued", sourceDeleted: false });
  const again = await handleLibraryCommand({ action: "play", id: "wg-fixture", confirm: true, processes: [] }, dir);
  expect(again).toMatchObject({ created: false, sourceDeleted: false });
  const queued = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { kind: string; sourceDeleted: boolean }[] };
  expect(queued.jobs).toEqual([expect.objectContaining({ kind: "copy", sourceDeleted: false })]);
  const catalog = JSON.parse(await readFile(path.join(dir, "windows-library.json"), "utf8")) as { jobs: unknown[] };
  expect(catalog.jobs).toEqual([]);

  const early = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "return", id: "wg-fixture", confirm: true, processes: [] }) }));
  expect(early.status).toBe(400);
  expect(await readFile(path.join(source, "data.bin"), "utf8")).toBe("payload-bytes");

  expect(evictPreparedGame("game-exit").evict).toBe(false);
  expect(evictPreparedGame("space-pressure").evict).toBe(false);
  const dispatched = await dispatchOnce(dir);
  expect(dispatched.processed).toContain("game");
  const done = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: { kind: string; state: string; verified: boolean; sourceDeleted: boolean }[] };
  expect(done.jobs).toHaveLength(1);
  expect(done.jobs[0]).toMatchObject({ kind: "copy", state: "done", verified: true, sourceDeleted: false });
  expect(await readFile(path.join(source, "data.bin"), "utf8")).toBe("payload-bytes");
  const library = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8")) as { games: { id: string; pinned: string; copyVerified: boolean; destination: string }[] };
  expect(library.games).toHaveLength(1);
  expect(library.games[0]).toMatchObject({ pinned: "until-explicit-remove", copyVerified: true });
  expect((await stat(path.join(library.games[0]!.destination, "data.bin"))).isFile()).toBe(true);
  const listed = await GET();
  const view = (await listed.json()) as { games: { pool: string; root: string; compression: string }[] };
  expect(view.games[0]).toMatchObject({ pool: "playing", root: source, compression: "uncompressed" });

  await writeFile(path.join(source, "data.bin"), "changed");
  const drifted = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "return", id: "wg-fixture", confirm: true, processes: [] }) }));
  expect(drifted.status).toBe(400);
  expect((await stat(path.join(library.games[0]!.destination, "data.bin"))).isFile()).toBe(true);
  await writeFile(path.join(source, "data.bin"), "payload-bytes");

  const removed = await POST(new Request("http://local/api/windows-library", { method: "POST", body: JSON.stringify({ action: "return", id: "wg-fixture", confirm: true, processes: [] }) }));
  expect(removed.status).toBe(200);
  const body = (await removed.json()) as { removed: boolean; sourceKept: boolean; sourceDeleted: boolean; library: { games: { pool: string }[] } };
  expect(body).toMatchObject({ removed: true, sourceKept: true, sourceDeleted: false });
  expect(body.library.games[0]?.pool).toBe("archive");
  await expect(stat(library.games[0]!.destination)).rejects.toThrow();
  expect(await readFile(path.join(source, "data.bin"), "utf8")).toBe("payload-bytes");
  const still = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
  expect(still.jobs).toHaveLength(1);
  } finally {
    if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
    else process.env.SKLAD_DATA_DIR = previousData;
    if (previousDb === undefined) delete process.env.SKLAD_COMPACT_DB;
    else process.env.SKLAD_COMPACT_DB = previousDb;
  }
});

function steamFixture(): Buffer {
  return encodeMftFixture([
    { recordNumber: 5, parentRecord: 5, isDirectory: true, name: "." },
    { recordNumber: 10, parentRecord: 5, isDirectory: true, name: "Steam" },
    { recordNumber: 11, parentRecord: 10, isDirectory: true, name: "steamapps" },
    { recordNumber: 12, parentRecord: 11, isDirectory: true, name: "common" },
    { recordNumber: 13, parentRecord: 12, isDirectory: true, name: "Fixture" },
    { recordNumber: 14, parentRecord: 13, name: "Fixture.exe", size: 100 },
    { recordNumber: 15, parentRecord: 11, name: "appmanifest_424242.acf", size: 20 },
    { recordNumber: 16, parentRecord: 11, name: "libraryfolders.vdf", size: 40 },
  ]);
}

function manifestText(): string {
  return `"AppState"\n{\n"appid"\t\t"424242"\n"name"\t\t"Fixture"\n"installdir"\t\t"Fixture"\n"StateFlags"\t\t"4"\n}\n`;
}

async function gameDir(dir: string): Promise<string> {
  const source = path.join(dir, "Fixture");
  await mkdir(path.join(source, "saves"), { recursive: true });
  await writeFile(path.join(source, "data.bin"), "payload-bytes");
  await writeFile(path.join(source, "saves", "slot.txt"), "1");
  const exe = path.join(source, "play.mjs");
  await writeFile(exe, "#!/usr/bin/env node\n");
  await chmod(exe, 0o755);
  await writeFile(path.join(source, "sklad-game.json"), JSON.stringify({ name: "Fixture", steamAppId: 424242, exe: "play.mjs", args: [], saves: ["saves/slot.txt"] }));
  return source;
}

async function compactDb(dir: string): Promise<string> {
  const file = path.join(dir, "compact.json");
  await writeFile(file, JSON.stringify([{ SteamID: 424242, GameName: "Fixture", FolderName: "Fixture", Confidence: 2, CompressionResults: [{ CompType: 1, BeforeBytes: 1000, AfterBytes: 950, TotalResults: 2 }], TotalFiles: 1 }]));
  return file;
}
