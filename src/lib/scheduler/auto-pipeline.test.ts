import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CatalogDisk } from "@/lib/drives/types";
import { emptyRules } from "@/lib/policies/presets";
import { pipelineBudget, pipelineEffects, resetPipelineEffectsForTests } from "@/lib/scheduler/auto-effects";
import {
  drainPipelineForTests,
  enqueuePipelineRun,
  pipelineView,
  resetAutoPipelineForTests,
  setPipelineEffectsForTests,
} from "@/lib/scheduler/auto-queue";
import { selectTriggers } from "@/lib/scheduler/auto-watch";

describe("auto pipeline", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-auto-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetAutoPipelineForTests();
    resetPipelineEffectsForTests();
  });

  afterEach(async () => {
    resetAutoPipelineForTests();
    resetPipelineEffectsForTests();
    delete process.env.SKLAD_DATA_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("does not touch Z: and does not start work inside the caller", async () => {
    let indexCalls = 0;
    setPipelineEffectsForTests({
      ...pipelineEffects,
      async requestIndex() {
        indexCalls += 1;
        return "Индекс";
      },
    });
    const skipped = enqueuePipelineRun({
      trigger: "torrent",
      key: "torrent:z",
      title: "secret",
      hostId: "pc",
      hash: "ab",
      diskId: null,
      sourcePath: "Z:\\private\\movie.mkv",
      os: "win32",
      name: "secret",
    });
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.note).toBe("Диск Z: пропущен.");
    expect(skipped?.sourcePath).toBe("");
    expect(indexCalls).toBe(0);
    const view = await pipelineView();
    expect(view.deletesSource).toBe(false);
    expect(JSON.stringify(view)).not.toContain("private");
    expect(await drainPipelineForTests()).toBe(0);
    expect(indexCalls).toBe(0);
  });

  it("copies a finished file in the background, then checks the hash", async () => {
    const sourceDir = path.join(dir, "incoming");
    const library = path.join(dir, "library");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sourceDir, { recursive: true });
    const body = "кадр-01-кадр-02-кадр";
    const source = path.join(sourceDir, "film.mkv");
    await writeFile(source, body);
    const rules = emptyRules();
    rules.movie = { ...rules.movie, diskId: "disk-test", folder: "Cinema", postAction: "handbrake", indexProfile: "walk" };
    const disk: CatalogDisk = {
      id: "disk-test",
      serial: "SN",
      uuid: "UUID",
      label: "Тест",
      online: true,
      filesystem: "apfs",
      mounts: [{ hostId: "host-1", os: "darwin", path: library }],
    };
    let copies = 0;
    setPipelineEffectsForTests({
      ...pipelineEffects,
      async requestIndex() {
        return "Индекс поставлен в очередь.";
      },
      async torrentFiles() {
        return [{ name: "film.mkv", size: Buffer.byteLength(body) }];
      },
      async context() {
        return { rules, disks: [disk] };
      },
      async copyChunk(file, dest, offset) {
        copies += 1;
        return pipelineEffects.copyChunk(file, dest, offset);
      },
    });
    pipelineBudget.chunkBytes = 4;

    const run = enqueuePipelineRun({
      trigger: "torrent",
      key: "torrent:host-1:abc",
      title: "Ну погоди",
      hostId: "host-1",
      hash: "abc",
      diskId: "disk-test",
      sourcePath: source,
      os: "darwin",
      name: "Ну погоди",
    });
    expect(run?.status).toBe("queued");
    expect(run?.stage).toBe("index");
    expect(copies).toBe(0);

    const steps = await drainPipelineForTests();
    expect(steps).toBeGreaterThan(copies);
    expect(copies).toBeGreaterThan(1);
    expect(run?.status).toBe("done");
    expect(run?.deletesSource).toBe(false);
    expect(await readFile(source, "utf8")).toBe(body);
    const copied = await readFile(path.join(library, "Cinema", "Ну погоди", "film.mkv"), "utf8");
    expect(copied).toBe(body);
    expect(run?.note).toMatch(/SHA-256 совпал/);
    expect(run?.note).toMatch(/не удаляется/);
    const view = await pipelineView();
    expect(view.deletesSource).toBe(false);
    expect(JSON.stringify(view)).not.toContain('"deletesSource":true');
  });

  it("types a mounted disk by its top folders and leaves them in place", async () => {
    const root = path.join(dir, "disk");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "Мультики"), { recursive: true });
    await mkdir(path.join(root, "Сериалы"), { recursive: true });
    await mkdir(path.join(root, "Фильмы"), { recursive: true });
    await writeFile(path.join(root, "Мультики", "nu.mkv"), "nu");
    setPipelineEffectsForTests({
      ...pipelineEffects,
      async requestIndex() {
        return "Индекс поставлен в очередь.";
      },
    });
    const run = enqueuePipelineRun({
      trigger: "disk",
      key: "disk:local",
      title: "Полка",
      hostId: "host-1",
      hash: "",
      diskId: null,
      sourcePath: root,
      os: "darwin",
      name: "Полка",
    });
    await drainPipelineForTests();
    expect(run?.status).toBe("done");
    expect(run?.note).toMatch(/Мультики: Мультфильм/);
    expect(run?.note).toMatch(/Сериалы: Сериал/);
    expect(run?.note).toMatch(/Фильмы: Фильм/);
    expect(run?.note).toMatch(/не копируются/);
    expect(await readFile(path.join(root, "Мультики", "nu.mkv"), "utf8")).toBe("nu");
    expect(run?.deletesSource).toBe(false);
  });
});

describe("pipeline triggers", () => {
  it("starts after a finished torrent or a disk and skips Z:", () => {
    const first = selectTriggers({
      torrents: [
        { hostId: "pc", hash: "a", name: "Done", savePath: "D:\\Downloads\\Done", progress: 1, state: "seeding", os: "win32" },
        { hostId: "pc", hash: "b", name: "Busy", savePath: "D:\\Downloads\\Busy", progress: 0.2, state: "downloading", os: "win32" },
        { hostId: "pc", hash: "c", name: "Hidden", savePath: "Z:\\Hidden", progress: 1, state: "seeding", os: "win32" },
      ],
      disks: [
        { id: "games", label: "Игры", online: true, hostId: "pc", mounts: [{ path: "D:\\", os: "win32" }] },
        { id: "z", label: "Z", online: true, hostId: "pc", mounts: [{ path: "Z:\\", os: "win32" }] },
      ],
      seen: new Set(),
      diskOnline: {},
    });
    expect(first.seeds.map((seed) => seed.key)).toEqual(["torrent:pc:a", "disk:games"]);
    expect(first.skippedVolume).toBe(2);
    expect(JSON.stringify(first)).not.toContain("Hidden");
    const again = selectTriggers({
      torrents: [
        { hostId: "pc", hash: "a", name: "Done", savePath: "D:\\Downloads\\Done", progress: 1, state: "seeding", os: "win32" },
        { hostId: "pc", hash: "c", name: "Hidden", savePath: "Z:\\Hidden", progress: 1, state: "seeding", os: "win32" },
      ],
      disks: [
        { id: "games", label: "Игры", online: true, hostId: "pc", mounts: [{ path: "D:\\", os: "win32" }] },
        { id: "z", label: "Z", online: true, hostId: "pc", mounts: [{ path: "Z:\\", os: "win32" }] },
      ],
      seen: new Set(["torrent:pc:a", ...first.remember]),
      diskOnline: first.diskOnline,
    });
    expect(again.seeds).toEqual([]);
    expect(again.skippedVolume).toBe(0);
  });
});
