import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import type { CollectedVolume } from "../../src/addons/drives/types.ts";
import { parseWindowsVolumes, type WindowsVolumeReport } from "../../src/addons/drives/win-volumes.ts";
import { WINDOWS_VOLUME_SCRIPT } from "../../src/addons/drives/win-script.ts";

const exec = promisify(execFile);

export async function collectWindows(): Promise<{ elevated: boolean; volumes: CollectedVolume[]; note: string }> {
  if (process.platform !== "win32") {
    return { elevated: false, volumes: [], note: "Сборщик Windows запущен не на Windows." };
  }
  const request = { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOLUME_SCRIPT] };
  assertSpawnAllowed(request);
  const result = await exec(request.bin, request.args, { timeout: 30_000, windowsHide: true, maxBuffer: 12_000_000 });
  const report = JSON.parse(result.stdout) as WindowsVolumeReport;
  const parsed = parseWindowsVolumes(report);
  return { elevated: parsed.elevated, volumes: parsed.volumes, note: "" };
}
