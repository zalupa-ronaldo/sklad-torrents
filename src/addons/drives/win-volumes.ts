import type { CollectedVolume } from "@/addons/drives/types";
import { normalizeUuid } from "@/addons/drives/identity";

interface WinDisk {
  Index?: number | string;
  SerialNumber?: string | null;
  Size?: number | string;
}

interface WinPart {
  DiskNumber?: number | string;
  DriveLetter?: string | null;
}

interface WinVol {
  DriveLetter?: string | null;
  FileSystem?: string | null;
  FileSystemLabel?: string | null;
  Size?: number | string | null;
  SizeRemaining?: number | string | null;
  UniqueId?: string | null;
}

interface WinPerf {
  Name?: string | null;
  PercentDiskTime?: number | string | null;
}

export interface WindowsVolumeReport {
  disks?: WinDisk[] | WinDisk | null;
  parts?: WinPart[] | WinPart | null;
  vols?: WinVol[] | WinVol | null;
  perf?: WinPerf[] | WinPerf | null;
  admin?: boolean;
}

function asList<T>(value: T[] | T | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asNumber(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function letterOf(value: string | null | undefined): string {
  const text = String(value ?? "").trim().replace(":", "").toUpperCase();
  return /^[A-Z]$/.test(text) ? text : "";
}

export function parseWindowsVolumes(report: WindowsVolumeReport): { volumes: CollectedVolume[]; elevated: boolean } {
  const disks = asList(report.disks);
  const serialByDisk = new Map<number, string>();
  for (const disk of disks) {
    serialByDisk.set(asNumber(disk.Index), String(disk.SerialNumber ?? "").trim());
  }
  const diskByLetter = new Map<string, number>();
  for (const part of asList(report.parts)) {
    const letter = letterOf(part.DriveLetter);
    if (letter) diskByLetter.set(letter, asNumber(part.DiskNumber));
  }
  const busyLetters = new Set<string>();
  for (const perf of asList(report.perf)) {
    const letter = letterOf(perf.Name);
    if (letter && asNumber(perf.PercentDiskTime) >= 75) busyLetters.add(letter);
  }
  const volumes: CollectedVolume[] = [];
  for (const volume of asList(report.vols)) {
    const uuid = normalizeUuid(volume.UniqueId);
    if (!uuid) continue;
    const letter = letterOf(volume.DriveLetter);
    const diskNumber = letter ? diskByLetter.get(letter) : undefined;
    const serial = diskNumber === undefined ? "" : (serialByDisk.get(diskNumber) ?? "");
    volumes.push({
      serial,
      volumeUuid: String(volume.UniqueId ?? ""),
      filesystem: String(volume.FileSystem ?? "").trim() || "unknown",
      volumeName: String(volume.FileSystemLabel ?? "").trim(),
      mountPaths: letter ? [`${letter}:\\`] : [],
      totalBytes: asNumber(volume.Size),
      freeBytes: asNumber(volume.SizeRemaining),
      busy: letter ? busyLetters.has(letter) : false,
      letter: letter || null,
    });
  }
  return { volumes, elevated: report.admin === true };
}
