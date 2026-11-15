import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { browseDisk, browseRoots } from "@/addons/drives/browse";
import { searchDisks } from "@/addons/drives/search";
import { executeCompact } from "@/lib/games/compact-run";
import { hashFile } from "@/lib/games/library";
import { prepareGame, registerGame, removeGame, runGameOnce } from "@/lib/games/prepare";
import { classify as classifyContent } from "@/lib/content/classify";
import { classify as classifyKernel } from "@/lib/kernel/classify";
import { sha256Hex, treeReader } from "@/lib/integrity/hash";
import {
  clearIntegrityRuntimeForTests,
  enqueueIntegrity,
  getIntegrityJob,
} from "@/lib/integrity/engine";
import { resetIntegrityForTests } from "@/lib/integrity/store";
import { planDownloads } from "@/lib/scheduler/plan";
import type { CatalogDisk } from "@/lib/drives/types";
import { filterTorrents } from "@/lib/filter";
import { DEMO_HASH, DEMO_MAC_ID, DEMO_PC_ID } from "@/lib/qbittorrent/demo-data";
import { getMockClient, resetMockHost, resetMockStateForTests } from "@/lib/qbittorrent/mock-client";
import { assertPathForOs } from "@/lib/qbittorrent/paths";
import { normalizeState } from "@/lib/qbittorrent/state";
import type { TorrentSnapshot, TorrentView } from "@/lib/qbittorrent/types";
import { checkCapacity } from "@/lib/optical/capacity";
import { buildDiscImageStudioPlan } from "@/lib/optical/disc-image-studio";
import { buildMacOpticalJob } from "@/lib/optical/mac-controller";
import { planOptical } from "@/lib/optical/plan";
import { selectIndexStrategy } from "@/addons/drives/strategy";
import { emulatedCatalog } from "@/windows-emulation/world";

const dirs: string[] = [];
let previousData: string | undefined;

beforeEach(() => {
  previousData = process.env.SKLAD_DATA_DIR;
});

afterEach(async () => {
  clearIntegrityRuntimeForTests();
  resetMockStateForTests();
  if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousData;
  previousData = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("acceptance checklist on the Windows emulation", () => {
  it("downloads and seeds on Mac and the PC, moves a Windows torrent without losing the seed, and searches both", async () => {
    resetMockHost(DEMO_MAC_ID, "darwin");
    resetMockHost(DEMO_PC_ID, "win32");
    const mac = getMockClient({ id: DEMO_MAC_ID, os: "darwin" });
    const pc = getMockClient({ id: DEMO_PC_ID, os: "win32" });
    const macAdded = await mac.add({
      urls: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Mac+Download",
      savePath: "/Volumes/vault/Downloads",
    });
    const pcAdded = await pc.add({
      urls: "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=PC+Download",
      savePath: "D:\\Downloads",
    });
    expect(macAdded.hashes).toHaveLength(1);
    expect(pcAdded.hashes).toHaveLength(1);

    const before = (await pc.listTorrents()).find((torrent) => torrent.hash === DEMO_HASH.blender);
    expect(before?.state).toBe("seeding");
    expect(before?.savePath).toBe("D:\\Downloads");
    await pc.setLocation([DEMO_HASH.blender], "S:\\Software");
    const after = (await pc.listTorrents()).find((torrent) => torrent.hash === DEMO_HASH.blender);
    expect(after).toMatchObject({ hash: DEMO_HASH.blender, state: "seeding", savePath: "S:\\Software" });
    expect(after?.rawState).toBe(before?.rawState);
    expect(assertPathForOs("win32", "/mnt/d/Downloads")).toBe("D:\\Downloads");
    expect(() => assertPathForOs("win32", "Z:\\Archive")).toThrow(/Z/);
    expect(() => assertPathForOs("win32", "/mnt/z/Archive")).toThrow(/Z/);

    const macSeed = (await mac.listTorrents()).find((torrent) => torrent.hash === DEMO_HASH.interstellar);
    expect(normalizeState(macSeed?.rawState || "")).toBe("seeding");
    const views = [...(await mac.listTorrents()), ...(await pc.listTorrents())].map(asView);
    const found = filterTorrents(views, { q: "Blender" });
    expect(found.map((torrent) => torrent.hostId)).toEqual([DEMO_PC_ID]);
    expect(filterTorrents(views, { q: "Интерстеллар" }).map((torrent) => torrent.hostId)).toEqual([DEMO_MAC_ID]);

    const disks = emulatedCatalog();
    const screen = {
      disks: browseRoots(disks).entries.map((entry) => entry.name),
      files: searchDisks(disks, "ColdGame"),
      torrents: filterTorrents(views, { q: "Control" }).map((torrent) => torrent.name),
    };
    expect(screen.disks).not.toContain("Z:");
    expect(screen.files[0]?.connectHint).toMatch(/Подключите диск/);
    expect(screen.torrents).toEqual(["Control Ultimate Edition"]);
  });

  it("shows a folder tree with size and file count, including an offline disk, and indexes NTFS by MFT", () => {
    const disks = emulatedCatalog();
    const page = browseDisk(disks, "disk-d", "");
    const movies = page.entries.find((entry) => entry.name === "фильмы");
    expect(movies?.kind).toBe("dir");
    expect(movies?.size).toBe(2_000_000_000);
    expect(movies?.fileCount).toBe(1);
    const offline = browseDisk(disks, "disk-s", "игры/ColdGame");
    expect(offline.online).toBe(false);
    expect(offline.entries.map((entry) => entry.name)).toContain("game.exe");
    expect(searchDisks(disks, "game.exe")[0]?.reachable).toBe(false);
    expect(selectIndexStrategy({ filesystem: "NTFS", platform: "win32", elevated: true })).toMatchObject({
      strategy: "mft-usn",
      usesMft: true,
    });
  });

  it("classifies owner folders without a manual rule and keeps other platforms apart from Windows games", () => {
    expect(classifyContent({ name: "pack", savePath: "D:\\игры\\Hades" }).kind).toBe("game");
    expect(classifyContent({ name: "pack", savePath: "D:\\фильмы\\Interstellar" }).kind).toBe("movie");
    expect(classifyContent({ name: "pack", savePath: "D:\\сериалы\\Show" }).kind).toBe("series");
    expect(classifyContent({ name: "pack", savePath: "D:\\мультфильмы\\Cartoon" }).kind).toBe("cartoon");
    expect(classifyContent({ name: "pack", savePath: "D:\\музыка\\Ost" }).kind).toBe("music");
    expect(classifyContent({ name: "pack", savePath: "D:\\софт\\Setup" }).kind).toBe("software");
    expect(classifyContent({ name: "pack", savePath: "D:\\документы\\Notes" }).kind).toBe("document");

    expect(classifyKernel({ name: "Control", path: "Control.exe" }).kind).not.toBe("game-psp");
    expect(classifyKernel({ name: "God of War", path: "ULUS10479.iso" }).kind).toBe("game-psp");
    expect(classifyKernel({ name: "Zelda", path: "game.nsp" }).kind).toBe("game-console");
    expect(classifyKernel({ name: "Shadow of the Colossus", path: "ps2.iso" }).kind).toBe("game-console");
    expect(classifyKernel({ name: "Bloodborne", path: "ps4.iso" }).kind).toBe("game-console");
    expect(classifyKernel({ name: "OpenGothic", files: [{ name: "OpenGothic.exe" }] }).kind).not.toBe("game-console");
  });

  it("copies with SHA-256, leaves the original, and hashes downloads, compact and a burn", async () => {
    previousData = process.env.SKLAD_DATA_DIR;
    const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-copy-"));
    dirs.push(dir);
    process.env.SKLAD_DATA_DIR = dir;
    clearIntegrityRuntimeForTests();
    await resetIntegrityForTests();
    const original = new TextEncoder().encode("original-stays");
    for (const kind of ["torrent", "copy", "compact", "optical"] as const) {
      const job = await enqueueIntegrity({
        kind,
        title: kind,
        source: treeReader({ "file.bin": original }),
        destination: treeReader({ "file.bin": original }),
        rewritable: kind === "optical",
      });
      const done = await waitHash(job.id);
      expect(done.files.every((file) => file.sha256 === sha256Hex(original))).toBe(true);
      expect(done.deleteAllowed).toBe(false);
    }
  });

  it("moves a wanted game onto the pool with a checked copy, compresses on Windows NTFS, and puts it back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sklad-game-"));
    dirs.push(root);
    const cold = path.join(root, "hdd", "Hades");
    const pool = path.join(root, "ssd");
    await mkdir(cold, { recursive: true });
    await mkdir(pool, { recursive: true });
    await writeFile(path.join(cold, "Hades.exe"), "game-bytes");
    const registered = await registerGame({
      root: cold,
      pool,
      name: "Hades",
      exe: "Hades.exe",
      steamAppId: 1145360,
      directory: root,
    });
    expect(registered.ok).toBe(true);
    const id = (registered.game as { id: string }).id;
    const prepared = await prepareGame(id, null, root);
    expect(prepared.ok).toBe(true);
    const ran = await runGameOnce(root, null);
    expect(ran.verified).toBe(true);
    const destination = path.join(pool, id);
    expect(await readFile(path.join(destination, "Hades.exe"), "utf8")).toBe("game-bytes");
    expect(await readFile(path.join(cold, "Hades.exe"), "utf8")).toBe("game-bytes");
    expect((await hashFile(path.join(cold, "Hades.exe"))).sha256).toBe((await hashFile(path.join(destination, "Hades.exe"))).sha256);

    const compact = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "D:\\Games\\Hades",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
      measure: async () => ({ allocated: 40, wof: 20, logical: 80 }),
    });
    expect(compact.executed).toBe(true);
    expect(compact.argv?.join(" ")).toMatch(/compact\.exe/);
    expect(compact.argv?.join(" ")).toContain("XPRESS8K");
    expect(compact.compressed).toBe(false);
    const refused = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "Z:\\Games\\Hades",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(refused.executed).toBe(false);

    const removed = await removeGame(id, root);
    expect(removed).toMatchObject({ ok: true, removed: true, sourceKept: true });
    expect(await readFile(path.join(cold, "Hades.exe"), "utf8")).toBe("game-bytes");
  });

  it("plans CD, DVD and Blu-ray on the PC and lets the Mac queue the same job", () => {
    const files = [{ diskLabel: "vault", path: "D:\\диски\\album\\track.flac", name: "track.flac", size: 1000, kind: "file" as const }];
    for (const media of ["cd", "dvd-r", "dvd+r"] as const) {
      const plan = planOptical({
        action: "burn",
        platform: "win32",
        media,
        eraseConfirmed: false,
        device: "CdRom0",
        driveIndex: "0",
        files,
        outputDir: "D:\\диски\\out",
        label: "ALBUM",
      });
      expect(plan.erase).toBe(false);
      expect(plan.steps.map((step) => step.phase)).toEqual(["образ", "запись", "проверка"]);
    }
    expect(checkCapacity(1000, "cd").ok).toBe(true);
    expect(checkCapacity(1000, "dvd-sl").ok).toBe(true);

    const artwork = buildDiscImageStudioPlan({
      platform: "win32",
      action: "export",
      medium: "bd-r",
      artworkPath: "D:\\art\\cover.png",
      outputPath: "D:\\диски\\cover.iso",
    });
    expect(artwork.args.join(" ")).toContain("bd-generate");
    expect(artwork.args.join(" ")).toContain("cover.png");
    expect(artwork.writesDisc).toBe(false);

    const queued = buildMacOpticalJob({
      kind: "burn",
      sourcePath: "D:\\диски\\album",
      driveId: "win-dvd-0",
    });
    expect(queued.host).toBe("pc-agent");
    expect(queued.physicalDiscBurned).toBe(false);
    expect([...queued.argv, ...queued.plan].join("\n")).not.toMatch(/\bdrutil\s+burn\b/);
  });

  it("keeps one download per disk and does not resume a paused torrent", () => {
    const catalog: CatalogDisk[] = [
      {
        serial: "D-SERIAL",
        uuid: "UUID-D",
        label: "vault",
        online: true,
        filesystem: "ntfs",
        mounts: [{ hostId: "pc-agent", os: "win32", path: "D:\\" }],
      },
    ];
    const plan = planDownloads({
      catalog,
      order: {},
      priority: {},
      torrents: [
        torrent("a".repeat(40), "first", false),
        torrent("b".repeat(40), "second", false),
        torrent("c".repeat(40), "held", true),
      ],
    });
    expect(plan.queues).toHaveLength(1);
    expect(plan.queues[0]?.active).toBeTruthy();
    expect(plan.pause.map((item) => item.hash)).toContain("b".repeat(40));
    expect(plan.resume.map((item) => item.hash)).not.toContain("c".repeat(40));
    expect(plan.queues[0]?.manual.map((item) => item.hash)).toContain("c".repeat(40));
  });
});

function torrent(hash: string, name: string, userPaused: boolean) {
  return {
    hostId: "pc-agent",
    hostName: "DESKTOP-OLT9HAV",
    hostOs: "win32" as const,
    hash,
    name,
    savePath: "D:\\Downloads",
    state: "downloading" as const,
    rawState: "downloading",
    progress: 0.2,
    userPaused,
  };
}

function asView(snapshot: TorrentSnapshot): TorrentView {
  const hostId = snapshot.savePath.startsWith("/") ? DEMO_MAC_ID : DEMO_PC_ID;
  return {
    ...snapshot,
    hostId,
    hostName: hostId,
    hostOs: hostId === DEMO_MAC_ID ? "darwin" : "win32",
    moveMark: null,
  };
}

async function waitHash(id: string) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const job = await getIntegrityJob(id);
    if (job && (job.state === "done" || job.state === "error")) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`hash job ${id} did not finish`);
}
