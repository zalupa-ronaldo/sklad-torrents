import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { encodeMftFixture } from "@/addons/media-games/file-index/mft";
import { encodeUsnJournal, encodeUsnRecord, UsnReason } from "@/addons/media-games/file-index/usn";
import { AppError } from "@/lib/app-error";
import { advanceWindowsLibrary, applyLibraryCommand, emptyLibraryState } from "@/lib/windows-library/adapter";
import { moveSteamApp, retargetAppManifest } from "@/lib/windows-library/launchers";
import { MemoryFs } from "@/lib/windows-library/memory-fs";
import { moveRequest } from "@/lib/windows-library/screen-actions";
import { encodeReadUsnJournal, encodeUsnJournalData, FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, parseUsnJournalData, usnJournalLost } from "@/lib/windows-library/usn-journal";
import type { VolumeIdentity, WinGame } from "@/lib/windows-library/types";
import { GET, POST } from "@/app/api/windows-library/route";

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

it("applies a USN create without rereading the MFT and moves a game only after confirm and a matching hash", () => {
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

  const game = playable(state.games[0]!);
  state.games = [game];
  state.settings.fastSsd = { serial: "SSD-1", uuid: "ssd-uuid", root: "S:\\Fast" };
  expect(() => applyLibraryCommand(state, { action: "play", id: game.id, confirm: false, processes: [] })).toThrow(/confirm/);
  expect(() => applyLibraryCommand(state, { action: "play", id: game.id, confirm: true, processes: [{ path: "D:\\Steam\\steamapps\\common\\Fixture\\Fixture.exe" }] })).toThrow(/запущена/);
  const queued = applyLibraryCommand(state, { action: "play", id: game.id, confirm: true, processes: [] }) as { job: { id: string; state: string } };
  expect(queued.job.state).toBe("queued");
  const fs = new MemoryFs();
  fs.writeText("D:/Steam/steamapps/common/Fixture/Fixture.exe", "game");
  fs.writeText("D:/Steam/steamapps/appmanifest_424242.acf", manifestText());
  fs.writeText("D:/Steam/steamapps/libraryfolders.vdf", `"libraryfolders"\n{\n"0"\n{\n"path"\t\t"D:\\\\Steam"\n"apps"\n{\n"424242"\t\t"100"\n}\n}\n}\n`);
  const broken = advanceWindowsLibrary(state, queued.job.id, fs, null, { mutateCopy: (_rel, bytes) => Buffer.concat([bytes, Buffer.from("x")]) });
  expect(broken.job.state).toBe("error");
  expect(broken.job.sourceDeleted).toBe(false);
  expect(fs.readText("D:/Steam/steamapps/common/Fixture/Fixture.exe")).toBe("game");

  const retry = applyLibraryCommand(state, { action: "play", id: game.id, confirm: true, processes: [] }) as { job: { id: string } };
  const done = advanceWindowsLibrary(state, retry.job.id, fs, null);
  expect(done.job.state).toBe("done");
  expect(done.job.verified).toBe(true);
  expect(done.job.sourceDeleted).toBe(true);
  expect(done.job.phase).toBe("queue-compact");
  expect(fs.readText("D:/Steam/steamapps/common/Fixture/Fixture.exe")).toBeNull();
  expect(fs.readText("S:/Fast/steamapps/common/Fixture/Fixture.exe")).toBe("game");
  const library = fs.readText("D:/Steam/steamapps/libraryfolders.vdf") ?? "";
  expect(library).toContain("S:\\Fast");
  expect(library).not.toMatch(/"424242"\s+"100"/);
  const nextManifest = fs.readText("S:/Fast/steamapps/appmanifest_424242.acf") ?? "";
  expect(nextManifest).toContain('"StateFlags"');
  expect(nextManifest).toContain('"4"');
  expect(nextManifest).toContain('"FullValidateAfterNextUpdate"');
  expect(nextManifest).toContain('"0"');
  const compress = state.jobs.find((job) => job.kind === "compress");
  expect(compress?.state).toBe("queued");
  expect(compress?.compactAlgorithm).toBe("XPRESS8K");
  const held = advanceWindowsLibrary(state, compress!.id, fs, null);
  expect(held.job.state).toBe("queued");
  expect(fs.readText("S:/Fast/steamapps/common/Fixture/Fixture.exe")).toBe("game");
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

function playable(game: WinGame): WinGame {
  return {
    ...game,
    root: "D:\\Steam\\steamapps\\common\\Fixture",
    archiveRoot: "D:\\Steam\\steamapps\\common\\Fixture",
    manifestPath: "D:\\Steam\\steamapps\\appmanifest_424242.acf",
    libraryFoldersPath: "D:\\Steam\\steamapps\\libraryfolders.vdf",
    installdir: "Fixture",
    logicalBytes: 4,
  };
}
