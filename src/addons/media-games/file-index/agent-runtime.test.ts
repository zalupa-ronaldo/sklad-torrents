import path from "node:path";
import { describe, expect, it } from "vitest";

import { agentIndex } from "@/addons/media-games/file-index/agent-runtime";
import { demoLibraryRoot } from "@/addons/media-games/file-index/demo-volumes";

describe("PC agent index decision", () => {
  it("walks a Windows NTFS volume when this process is not an elevated Windows reader", async () => {
    const status = await agentIndex().build({
      host: "Windows PC",
      volume: "D:",
      filesystem: "ntfs",
      preferUsn: true,
      walkRoot: path.join(demoLibraryRoot(), "windows-d"),
    });
    expect(status.source).toBe("walk");
    expect(status.elevated).toBe(false);
    expect(status.message).toMatch(/MFT недоступен/);
    expect(status.message).toMatch(/обходом папок/);
    const hit = agentIndex().search("Cyberpunk")[0];
    expect(hit).toMatchObject({
      host: "Windows PC",
      source: "walk",
      volume: "D:",
    });
    expect(hit?.path.startsWith("D:\\")).toBe(true);
  });

  it("never selects MFT for /Volumes/vault", async () => {
    const status = await agentIndex().build({
      host: "Mac mini",
      volume: "/Volumes/vault",
      filesystem: "ntfs",
      preferUsn: true,
      walkRoot: path.join(demoLibraryRoot(), "vault"),
    });
    expect(status.source).toBe("walk");
    expect(status.message).toMatch(/не используют MFT|обходом папок/);
    const hit = agentIndex().search("Hades", { volume: "/Volumes/vault" })[0];
    expect(hit?.host).toBe("Mac mini");
    expect(hit?.path.startsWith("/Volumes/vault/")).toBe(true);
    expect(hit?.source).toBe("walk");
  });
});
