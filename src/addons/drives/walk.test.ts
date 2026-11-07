import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { walkTree } from "../../../agents/lib/walk.mts";

describe("walkTree", () => {
  let root = "";

  afterEach(async () => {
    if (!root) return;
    try {
      await chmod(path.join(root, "System Volume Information"), 0o755);
    } catch {
      // The directory was not created.
    }
    await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("records file sizes and skips a child that cannot be listed", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sklad-walk-"));
    await writeFile(path.join(root, "ok.txt"), "hello");
    const nested = path.join(root, "Games");
    await mkdir(nested);
    await writeFile(path.join(nested, "game.exe"), "x");
    await symlink(path.join(root, "ok.txt"), path.join(root, "link.txt"));
    const blocked = path.join(root, "System Volume Information");
    await mkdir(blocked);
    await writeFile(path.join(blocked, "hidden.txt"), "secret");
    await chmod(blocked, 0);

    const result = await walkTree(root);
    expect(result.complete).toBe(true);
    const byPath = new Map(result.files.map((file) => [file.relativePath, file]));
    expect(byPath.get("ok.txt")?.size).toBe(5);
    expect(byPath.get("Games")?.kind).toBe("dir");
    expect(byPath.get("Games/game.exe")?.size).toBe(1);
    expect(byPath.get("link.txt")?.kind).toBe("file");
    expect(byPath.has("link.txt/ok.txt")).toBe(false);

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (uid !== 0) {
      expect(byPath.has("System Volume Information")).toBe(true);
      expect([...byPath.keys()].some((name) => name.endsWith("hidden.txt"))).toBe(false);
    }
  });

  it("fails closed when the volume root itself cannot be read", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sklad-walk-root-"));
    await chmod(root, 0);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (uid === 0) {
      await chmod(root, 0o755);
      return;
    }
    const result = await walkTree(root);
    expect(result).toEqual({ files: [], complete: false });
    await chmod(root, 0o755);
  });
});
