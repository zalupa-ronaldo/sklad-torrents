import path from "node:path";

import { dataDir as skladDataDir } from "@/lib/qbittorrent/store";

let override: string | null = null;

export function appDataDir(): string {
  return override ?? skladDataDir();
}

export function setAppDataDir(dir: string | null): void {
  override = dir;
}

export function jobsFile(): string {
  return path.join(appDataDir(), "localsend-jobs.json");
}
