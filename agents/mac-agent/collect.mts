import { readdir } from "node:fs/promises";
import path from "node:path";

import type { CollectedVolume } from "../../src/addons/drives/types.ts";
import { describeMacMount, forgetMacMount } from "./mount.mts";

export { describeMacMount, forgetMacMount };

export async function collectMac(): Promise<{ elevated: boolean; volumes: CollectedVolume[]; note: string }> {
  if (process.platform !== "darwin") {
    return { elevated: false, volumes: [], note: "Сборщик macOS запущен не на Mac." };
  }
  const names = await readdir("/Volumes").catch(() => [] as string[]);
  const volumes: CollectedVolume[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const volume = await describeMacMount(path.join("/Volumes", name));
    if (volume) volumes.push(volume);
  }
  const elevated = typeof process.getuid === "function" && process.getuid() === 0;
  return { elevated, volumes, note: "" };
}
