import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { demoLibraryRoot, DEMO_VOLUMES } from "@/addons/media-games/file-index/demo-volumes";
import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("search", () => {
  it("returns the host and the full path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sklad-search-"));
    dirs.push(root);
    await mkdir(path.join(root, "Games", "Celeste"), { recursive: true });
    await writeFile(path.join(root, "Games", "Celeste", "Celeste.exe"), "demo");

    const index = new MemoryFileIndex();
    await index.indexVolume({
      host: "Mac mini",
      volume: "/Volumes/vault",
      os: "darwin",
      filesystem: "apfs",
      elevated: false,
      walkRoot: root,
    });
    await index.indexVolume({
      host: "Windows PC",
      volume: "D:",
      os: "win32",
      filesystem: "ntfs",
      elevated: false,
      walkRoot: root,
    });

    const hits = index.search("Celeste.exe");
    expect(hits).toEqual([
      expect.objectContaining({
        host: "Mac mini",
        path: "/Volumes/vault/Games/Celeste/Celeste.exe",
        source: "walk",
      }),
      expect.objectContaining({
        host: "Windows PC",
        path: "D:\\Games\\Celeste\\Celeste.exe",
        source: "walk",
      }),
    ]);
    expect(hits.every((hit) => hit.host.length > 0 && hit.path.length > 0)).toBe(true);
  });

  it("walks the demo library with the same hit shape", async () => {
    const mac = DEMO_VOLUMES.find((volume) => volume.id === "mac-vault");
    const windows = DEMO_VOLUMES.find((volume) => volume.id === "win-games");
    expect(mac?.walkRoot.startsWith(demoLibraryRoot())).toBe(true);
    expect(windows?.route).toBe("pc-agent");

    const index = new MemoryFileIndex();
    const status = await index.indexVolume({
      host: mac!.host,
      volume: mac!.volume,
      os: mac!.os,
      filesystem: mac!.filesystem,
      elevated: true,
      preferUsn: true,
      walkRoot: mac!.walkRoot,
    });
    expect(status.source).toBe("walk");
    const hades = index.search("Hades");
    expect(hades.some((hit) => hit.host === "Mac mini" && hit.path.startsWith("/Volumes/vault/"))).toBe(true);
    expect(hades.every((hit) => hit.source === "walk")).toBe(true);
  });
});
