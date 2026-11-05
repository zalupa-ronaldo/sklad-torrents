import path from "node:path";

import type { IndexFilesystem, IndexOs } from "@/addons/media-games/file-index/types";

export interface DemoVolume {
  id: "mac-vault" | "win-games";
  host: string;
  volume: string;
  os: IndexOs;
  filesystem: IndexFilesystem;
  /** Mac paths are walked in the dashboard process. NTFS volumes go to the PC agent. */
  route: "local" | "pc-agent";
  walkRoot: string;
}

export function demoLibraryRoot(): string {
  return path.resolve(process.cwd(), "src/addons/media-games/file-index/demo-library");
}

export function demoVolumes(): DemoVolume[] {
  const root = demoLibraryRoot();
  return [
    {
      id: "mac-vault",
      host: "Mac mini",
      volume: "/Volumes/vault",
      os: "darwin",
      filesystem: "apfs",
      route: "local",
      walkRoot: path.join(root, "vault"),
    },
    {
      id: "win-games",
      host: "Windows PC",
      volume: "D:",
      os: "win32",
      filesystem: "ntfs",
      route: "pc-agent",
      walkRoot: path.join(root, "windows-d"),
    },
  ];
}

export function demoVolumeById(id: string): DemoVolume | undefined {
  return demoVolumes().find((volume) => volume.id === id);
}

/** @deprecated Use demoVolumes(). Kept as a snapshot for tests that import the list. */
export const DEMO_VOLUMES = demoVolumes();
