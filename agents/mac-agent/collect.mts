import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import { createDiskutilCache } from "../../src/addons/drives/collect-cache.ts";
import { parseDiskutil } from "../../src/addons/drives/diskutil.ts";
import type { CollectedVolume } from "../../src/addons/drives/types.ts";

const exec = promisify(execFile);
const diskutilCache = createDiskutilCache();

export async function collectMac(): Promise<{ elevated: boolean; volumes: CollectedVolume[]; note: string }> {
  if (process.platform !== "darwin") {
    return { elevated: false, volumes: [], note: "Сборщик macOS запущен не на Mac." };
  }
  return diskutilCache(readDiskutil);
}

async function readDiskutil(): Promise<{ elevated: boolean; volumes: CollectedVolume[]; note: string }> {
  const request = { bin: "diskutil", args: ["info", "-all"] };
  assertSpawnAllowed(request);
  const result = await exec(request.bin, request.args, { timeout: 20_000, maxBuffer: 12_000_000 });
  const elevated = typeof process.getuid === "function" && process.getuid() === 0;
  return { elevated, volumes: parseDiskutil(result.stdout), note: "" };
}
