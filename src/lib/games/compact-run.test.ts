import { describe, expect, it } from "vitest";

import { compactAllowsLaunch, executeCompact } from "@/lib/games/compact-run";

describe("compact.exe contract", () => {
  it("does not spawn on Linux and does not call the result compressed", async () => {
    let spawned = false;
    const result = await executeCompact({
      os: "linux",
      filesystem: "ext4",
      role: "game-pool",
      root: "/tmp/game",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => {
        spawned = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(spawned).toBe(false);
    expect(result).toMatchObject({ executed: false, compressed: false, ntfsSmoke: false, contractReady: false });
  });

  it("rejects E: before a process and does not treat a failed or unmeasured run as compressed", async () => {
    const blocked = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "E:\\Games\\A",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(blocked.executed).toBe(false);
    expect(blocked.reason).toMatch(/E и Z/);

    const failed = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "D:\\Pool\\Game",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => ({ code: 1, stdout: "", stderr: "fail" }),
    });
    expect(failed).toMatchObject({ executed: true, compressed: false, contractReady: false });

    const unmeasured = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "D:\\Pool\\Game",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async () => ({ code: 0, stdout: "done", stderr: "" }),
    });
    expect(unmeasured.allocated).toBeNull();
    expect(unmeasured.wof).toBeNull();
    expect(unmeasured.compressed).toBe(false);
  });

  it("accepts the process contract from injected metrics without claiming a physical NTFS run", async () => {
    const result = await executeCompact({
      os: "win32",
      filesystem: "NTFS",
      role: "game-pool",
      root: "D:\\Pool\\Game",
      escapes: [],
      algorithm: "XPRESS8K",
      spawnImpl: async (_bin, args) => {
        expect(args).toContain("/EXE:XPRESS8K");
        return { code: 0, stdout: "", stderr: "" };
      },
      measure: async () => ({ allocated: 100, wof: 40 }),
    });
    expect(result).toMatchObject({ executed: true, compressed: false, ntfsSmoke: false, contractReady: true, allocated: 100, wof: 40 });
    expect(compactAllowsLaunch(result)).toBe(false);
    expect(compactAllowsLaunch({ ...result, compressed: true, reason: "native" })).toBe(true);
  });
});
