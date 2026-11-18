import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import { createVolumeInfoCache } from "../../src/addons/drives/collect-cache.ts";
import { parseDiskutil } from "../../src/addons/drives/diskutil.ts";
import type { CollectedVolume } from "../../src/addons/drives/types.ts";

const exec = promisify(execFile);
const infoCache = createVolumeInfoCache();

export function forgetMacMount(mount: string) {
  infoCache.forget(mount);
}

/** One `diskutil info` for a mount. A second call for the same mount does not spawn again. */
export async function describeMacMount(mount: string): Promise<CollectedVolume | null> {
  if (process.platform !== "darwin") return null;
  return infoCache.once(mount, async () => {
    const request = { bin: "diskutil", args: ["info", mount] };
    assertSpawnAllowed(request);
    const result = await exec(request.bin, request.args, { timeout: 20_000, maxBuffer: 2_000_000 });
    return parseDiskutil(result.stdout)[0] ?? null;
  });
}
