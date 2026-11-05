import path from "node:path";

import type { MediaKind, OpticalPhase } from "@/lib/optical/media";

/**
 * Native commands. Nothing here is executed by tests.
 *
 * macOS (ships with the OS):
 * - detect: `drutil status`, `drutil list`, `diskutil info <device>`
 * - ISO: `hdiutil makehybrid -o <iso> -iso -joliet <folder>`
 * - burn: `hdiutil burn -device <device> -noverifyburn -noeject <iso>`
 *   `-erase` is added only when the job stored an explicit confirmation.
 *   man hdiutil: `-erase` quickly erases DVD-RW/CD-RW and then burns if an image is given.
 * - verify, only after burn exits 0:
 *   `hdiutil checksum -type SHA256 <iso>` (read-back hash of the ISO)
 *   `drutil status` (read the drive; does not write)
 * - erase button: `drutil -drive <n> erase full` (man drutil / Disc Recording). Not `bulkerase`,
 *   which keeps asking for the next disc.
 *
 * Windows:
 * - detect: PowerShell `Get-CimInstance Win32_CDROMDrive` plus IMAPI2
 *   (`IMAPI2.MsftDiscMaster2` / `MsftDiscFormat2Data`). Fallback: `wmic cdrom get ...`
 * - ISO: `oscdimg -n -m -l<LABEL> <folder> <iso>` from the Windows ADK. Not bundled.
 * - burn: `powershell.exe -File scripts/optical/imapi-burn.ps1` (IMAPI2FS + DiscFormat2Data).
 *   `-Erase:$false` unless confirmation is stored. No Nero.
 * - verify: `scripts/optical/imapi-verify.ps1` runs `Get-FileHash -Algorithm SHA256`.
 */

export type CommandPlatform = "darwin" | "win32";

export function scriptPath(name: string): string {
  return path.join(process.cwd(), "scripts", "optical", name);
}

export function isoArgv(platform: CommandPlatform, sourceDir: string, isoPath: string, label: string): string[] {
  if (platform === "darwin") {
    return ["hdiutil", "makehybrid", "-o", isoPath, "-iso", "-joliet", sourceDir];
  }
  return ["oscdimg", "-n", "-m", `-l${volumeLabel(label)}`, sourceDir, isoPath];
}

export function burnArgv(
  platform: CommandPlatform,
  device: string,
  isoPath: string,
  sourceDir: string,
  erase: boolean,
): string[] {
  if (platform === "darwin") {
    const argv = ["hdiutil", "burn", "-device", device, "-noverifyburn", "-noeject"];
    if (erase) argv.push("-erase");
    argv.push(isoPath);
    return argv;
  }
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    scriptPath("imapi-burn.ps1"),
    "-Source",
    sourceDir,
    "-Image",
    isoPath,
    "-RecorderId",
    device,
    `-Erase:$${erase ? "true" : "false"}`,
  ];
}

export function verifyArgv(platform: CommandPlatform, isoPath: string, device: string): string[][] {
  if (platform === "darwin") {
    return [
      ["hdiutil", "checksum", "-type", "SHA256", isoPath],
      ["drutil", "status"],
    ];
  }
  return [
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      scriptPath("imapi-verify.ps1"),
      "-Image",
      isoPath,
      "-RecorderId",
      device,
    ],
  ];
}

export function eraseArgv(platform: CommandPlatform, device: string, driveIndex: string | null): string[] {
  if (platform === "darwin") {
    return ["drutil", "-drive", driveIndex || "1", "erase", "full"];
  }
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    scriptPath("imapi-burn.ps1"),
    "-RecorderId",
    device,
    "-Erase",
    "-EraseOnly",
  ];
}

export const WINDOWS_DETECT_ARGV = [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-File",
  scriptPath("imapi-detect.ps1"),
];

export const WINDOWS_WMIC_ARGV = [
  "wmic",
  "cdrom",
  "get",
  "DeviceID,Name,Drive,MediaLoaded,MediaType,Caption,PNPDeviceID",
  "/format:list",
];

export const MAC_DETECT_ARGV = [
  ["drutil", "status"],
  ["drutil", "list"],
] as const;

export function isRewritable(media: MediaKind): boolean {
  return media === "cd-rw" || media === "dvd-rw" || media === "dvd+rw";
}

export function volumeLabel(label: string): string {
  const clean = label
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_ -]/g, "")
    .trim()
    .slice(0, 16);
  return clean || "SKLAD";
}

export function phaseOfVerify(): OpticalPhase {
  return "проверка";
}
