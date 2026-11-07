import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import type { CollectedVolume } from "../../src/addons/drives/types.ts";
import { parseWindowsVolumes, windowsSkipNote, type WindowsVolumeReport } from "../../src/addons/drives/win-volumes.ts";
import { loadVolumeGuard } from "../../src/addons/drives/volume-guard.ts";
import { WINDOWS_VOLUME_SCRIPT } from "../../src/addons/drives/win-script.ts";

const exec = promisify(execFile);

export async function collectWindows(): Promise<{ elevated: boolean; volumes: CollectedVolume[]; note: string }> {
  if (process.platform !== "win32") {
    return { elevated: false, volumes: [], note: "Сборщик Windows запущен не на Windows." };
  }
  const guard = await loadVolumeGuard();
  const request = { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOLUME_SCRIPT] };
  assertSpawnAllowed(request);
  // A busy PC often needs longer than 30s for the volume script. Keep 120s so a later install does not drop it.
  // Excluded letters are removed inside the script before any Get-Volume, Get-Partition, or CIM call.
  const result = await exec(request.bin, request.args, {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 12_000_000,
    env: { ...process.env, SKLAD_EXCLUDE_LETTERS: [...guard.excludeLetters].join(",") },
  });
  const report = JSON.parse(result.stdout) as WindowsVolumeReport;
  const parsed = parseWindowsVolumes(report, {
    excludeLetters: [...guard.excludeLetters],
    excludeUuids: [...guard.excludeUuids],
    excludeSerials: [...guard.excludeSerials],
  });
  // admin is the process token. A missing or denied letter stays in the note and does not clear it.
  return { elevated: parsed.elevated, volumes: parsed.volumes, note: windowsSkipNote(report, parsed.volumes) };
}
