import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyVolumeProbeError, WINDOWS_VOLUME_SCRIPT } from "@/addons/drives/win-script";
import { parseWindowsVolumes, windowsSkipNote } from "@/addons/drives/win-volumes";

function findPwsh(): string | null {
  const candidates = [
    process.env.PWSH_BIN,
    "pwsh",
    "powershell",
    path.join(homedir(), "powershell", "pwsh"),
  ].filter((item): item is string => Boolean(item));
  for (const bin of candidates) {
    const result = spawnSync(bin, ["-NoProfile", "-Command", "1"], { encoding: "utf8" });
    if (result.status === 0) return bin;
  }
  return null;
}

const pwsh = findPwsh();

function asList<T>(value: T[] | T | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

describe("stale registry letters", () => {
  it("classifies a missing letter and an access denial separately", () => {
    expect(classifyVolumeProbeError(
      "CmdletizationQuery_NotFound_DriveLetter,Get-Volume\nNo MSFT_Volume objects found with property 'DriveLetter' equal to 'G'.",
    )).toBe("absent");
    expect(classifyVolumeProbeError("UnauthorizedAccessException\nAccess is denied")).toBe("access");
    expect(classifyVolumeProbeError("Отказано в доступе")).toBe("access");
    expect(classifyVolumeProbeError("some other failure")).toBe("error");
  });

  it("keeps the administrator token when G is absent and Z stays excluded", () => {
    const report = {
      admin: true,
      skipped: [{ letter: "G", kind: "absent", message: "CmdletizationQuery_NotFound_DriveLetter" }],
      disks: [0, 1, 2, 3].map((index) => ({ Index: index, SerialNumber: `SERIAL-${index}`, Size: 100 })),
      parts: ["C", "D", "E", "S"].map((letter, index) => ({ DiskNumber: index, DriveLetter: letter })),
      vols: ["C", "D", "E", "S"].map((letter, index) => ({
        DriveLetter: letter,
        FileSystem: "NTFS",
        FileSystemLabel: letter,
        Size: 100,
        SizeRemaining: 10,
        UniqueId: `\\\\?\\Volume{00000000-0000-4000-8000-00000000000${index + 1}}\\`,
      })),
    };
    const parsed = parseWindowsVolumes(report, { excludeLetters: ["Z"] });
    expect(parsed.elevated).toBe(true);
    expect(parsed.volumes.map((volume) => volume.letter)).toEqual(["C", "D", "E", "S"]);
    const note = windowsSkipNote(report, parsed.volumes);
    expect(note).toContain("G");
    expect(note).not.toContain("Z");
    expect(note).toMatch(/без тома/);
  });

  it("keeps the administrator token when a letter denies access", () => {
    const report = {
      admin: true,
      skipped: [{ letter: "G", kind: "access", message: "Access is denied" }],
      vols: ["C", "D", "E", "S"].map((letter, index) => ({
        DriveLetter: letter,
        FileSystem: "NTFS",
        FileSystemLabel: letter,
        Size: 100,
        SizeRemaining: 10,
        UniqueId: `\\\\?\\Volume{00000000-0000-4000-8000-00000000000${index + 1}}\\`,
      })),
    };
    const parsed = parseWindowsVolumes(report, { excludeLetters: ["Z"] });
    expect(parsed.elevated).toBe(true);
    expect(windowsSkipNote(report, parsed.volumes)).toMatch(/Нет доступа к тому: G/);
  });
});

describe.skipIf(!pwsh)("windows inventory script against a stale registry", () => {
  async function run(mode: "absent" | "access") {
    const directory = await mkdtemp(path.join(tmpdir(), "sklad-win-inventory-"));
    const logPath = path.join(directory, "probes.txt");
    const prelude = `
$ErrorActionPreference = 'Stop'
$env:SKLAD_EXCLUDE_LETTERS = 'Z'
$env:SKLAD_PROBE_MODE = '${mode}'
$env:SKLAD_PROBE_LOG = '${logPath}'
function Test-SkladElevation { return $true }
function Get-ItemProperty {
  [CmdletBinding()] param([string]$Path)
  [pscustomobject]@{
    '\\DosDevices\\C:' = [byte]1
    '\\DosDevices\\D:' = [byte]1
    '\\DosDevices\\E:' = [byte]1
    '\\DosDevices\\G:' = [byte]1
    '\\DosDevices\\S:' = [byte]1
    '\\DosDevices\\Z:' = [byte]1
  }
}
function Get-Volume {
  [CmdletBinding()] param([string]$DriveLetter)
  Add-Content -Path $env:SKLAD_PROBE_LOG -Value ("Get-Volume:" + $DriveLetter)
  if ($DriveLetter -eq 'Z') { throw 'Z was queried' }
  if ($DriveLetter -eq 'G') {
    if ($env:SKLAD_PROBE_MODE -eq 'access') {
      $exception = New-Object System.UnauthorizedAccessException 'Access is denied'
      throw (New-Object System.Management.Automation.ErrorRecord($exception, 'UnauthorizedAccessException', 'PermissionDenied', $null))
    }
    $exception = New-Object System.InvalidOperationException "No MSFT_Volume objects found with property 'DriveLetter' equal to 'G'."
    throw (New-Object System.Management.Automation.ErrorRecord($exception, 'CmdletizationQuery_NotFound_DriveLetter,Get-Volume', 'ObjectNotFound', $null))
  }
  $ids = @{ C = '00000000-0000-4000-8000-000000000001'; D = '00000000-0000-4000-8000-000000000002'; E = '00000000-0000-4000-8000-000000000003'; S = '00000000-0000-4000-8000-000000000004' }
  [pscustomobject]@{ DriveLetter = $DriveLetter; FileSystem = 'NTFS'; FileSystemLabel = $DriveLetter; Size = 100; SizeRemaining = 10; UniqueId = ("\\\\?\\Volume{" + $ids[$DriveLetter] + "}\\") }
}
function Get-Partition {
  [CmdletBinding()] param([string]$DriveLetter)
  Add-Content -Path $env:SKLAD_PROBE_LOG -Value ("Get-Partition:" + $DriveLetter)
  if ($DriveLetter -eq 'Z' -or $DriveLetter -eq 'G') { throw "partition queried $DriveLetter" }
  $map = @{ C = 0; D = 1; E = 2; S = 3 }
  [pscustomobject]@{ DiskNumber = $map[$DriveLetter]; DriveLetter = $DriveLetter }
}
function Get-CimInstance {
  [CmdletBinding()] param([string]$ClassName, [string]$Filter)
  Add-Content -Path $env:SKLAD_PROBE_LOG -Value ("Get-CimInstance:" + $ClassName + ":" + $Filter)
  if ($Filter -match 'Z:' -or $ClassName -match 'Z') { throw 'Z was queried' }
  if ($Filter -match "Index=(\\d+)") {
    $n = [int]$Matches[1]
    return [pscustomobject]@{ Index = $n; SerialNumber = "SERIAL-$n"; Size = 100; Model = 'disk' }
  }
  if ($Filter -match "Name='([A-Z]):'") {
    return [pscustomobject]@{ Name = ($Matches[1] + ':'); PercentDiskTime = 1 }
  }
  throw "unexpected cim $ClassName $Filter"
}
`.trim();
    try {
      const stdout = execFileSync(pwsh as string, ["-NoProfile", "-NonInteractive", "-Command", `${prelude}\n${WINDOWS_VOLUME_SCRIPT}`], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      const report = JSON.parse(stdout) as {
        admin?: boolean;
        queried?: string[] | string;
        skipped?: { letter?: string; kind?: string }[] | { letter?: string; kind?: string };
        vols?: { DriveLetter?: string }[] | { DriveLetter?: string };
      };
      const probes = (await readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean);
      return { report, probes };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("queries C/D/E/S, isolates missing G, and does not clear a real administrator token", async () => {
    const { report, probes } = await run("absent");
    expect(report.admin).toBe(true);
    expect(asList(report.queried).sort()).toEqual(["C", "D", "E", "G", "S"]);
    expect(asList(report.vols).map((volume) => volume.DriveLetter).sort()).toEqual(["C", "D", "E", "S"]);
    expect(asList(report.skipped)).toEqual([
      expect.objectContaining({ letter: "G", kind: "absent" }),
    ]);
    expect(probes.filter((line) => line.startsWith("Get-Volume:")).sort()).toEqual([
      "Get-Volume:C",
      "Get-Volume:D",
      "Get-Volume:E",
      "Get-Volume:G",
      "Get-Volume:S",
    ]);
    expect(probes.filter((line) => line === "Get-Volume:G" || line === "Get-Partition:G" || line.includes("Name='G:'") || line.includes("Z"))).toEqual(["Get-Volume:G"]);
    const parsed = parseWindowsVolumes(report, { excludeLetters: ["Z"] });
    expect(parsed.elevated).toBe(true);
    expect(parsed.volumes.map((volume) => volume.letter).sort()).toEqual(["C", "D", "E", "S"]);
    expect(windowsSkipNote(report, parsed.volumes)).toContain("G");
  }, 30_000);

  it("isolates an access denial without querying Z or clearing the administrator token", async () => {
    const { report, probes } = await run("access");
    expect(report.admin).toBe(true);
    expect(asList(report.skipped)).toEqual([
      expect.objectContaining({ letter: "G", kind: "access" }),
    ]);
    expect(asList(report.vols).map((volume) => volume.DriveLetter).sort()).toEqual(["C", "D", "E", "S"]);
    expect(probes.some((line) => line.includes("Z"))).toBe(false);
    expect(parseWindowsVolumes(report, { excludeLetters: ["Z"] }).elevated).toBe(true);
  }, 30_000);
});
