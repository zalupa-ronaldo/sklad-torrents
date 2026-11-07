import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeSerial, normalizeUuid } from "@/addons/drives/identity";

export interface VolumeGuard {
  /** Listed, no automatic index. Manual rescan is still allowed. */
  manualOnly: Set<string>;
  /** Dropped before any volume, partition, CIM, perf, or device-handle call. */
  excludeLetters: Set<string>;
  excludeUuids: Set<string>;
  excludeSerials: Set<string>;
}

export function letterKey(value: string | null | undefined): string {
  const text = String(value ?? "").trim().replace(":", "").toUpperCase();
  return /^[A-Z]$/.test(text) ? text : "";
}

export function emptyVolumeGuard(): VolumeGuard {
  return {
    manualOnly: new Set(),
    excludeLetters: new Set(),
    excludeUuids: new Set(),
    excludeSerials: new Set(),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function addToken(token: string, guard: VolumeGuard): void {
  const text = token.trim();
  if (!text) return;
  const letter = letterKey(text);
  if (letter) {
    guard.excludeLetters.add(letter);
    return;
  }
  const uuid = normalizeUuid(text);
  if (uuid) {
    guard.excludeUuids.add(uuid);
    return;
  }
  const serial = normalizeSerial(text);
  if (serial) guard.excludeSerials.add(serial);
}

/** One config for inventory, startup, scan, resume, transfer, and compress. */
export function parseVolumeGuard(input: unknown): VolumeGuard {
  const guard = emptyVolumeGuard();
  const data = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const item of asArray(data.letters)) {
    const letter = letterKey(String(item));
    if (letter) guard.manualOnly.add(letter);
  }
  for (const item of asArray(data.exclude)) addToken(String(item), guard);
  for (const item of [...asArray(data.known), ...asArray(data.knownExcluded)]) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    // The letter in the known map is excluded before any probe. Serial and UUID are matched later, not discovered by opening the device.
    addToken(String(row.letter ?? ""), guard);
    addToken(String(row.volumeUuid ?? ""), guard);
    addToken(String(row.serial ?? ""), guard);
  }
  for (const letter of guard.excludeLetters) guard.manualOnly.delete(letter);
  return guard;
}

export function excludedLettersFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const guard = emptyVolumeGuard();
  for (const item of String(env.SKLAD_EXCLUDE_LETTERS ?? "").split(",")) addToken(item, guard);
  return guard.excludeLetters;
}

export function assertLetterAllowed(letter: string, excludeLetters: ReadonlySet<string> = excludedLettersFromEnv()): void {
  const key = letterKey(letter);
  if (!key) throw new Error("Некорректная буква тома.");
  if (excludeLetters.has(key)) throw new Error("Том исключён до открытия устройства.");
}

/** Letters that may be passed to Get-Volume / Get-Partition / CIM. Excluded letters are removed first. */
export function lettersToProbe(present: readonly string[], excludeLetters: readonly string[]): string[] {
  const exclude = new Set(excludeLetters.map((item) => letterKey(item)).filter(Boolean));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of present) {
    const letter = letterKey(item);
    if (!letter || exclude.has(letter) || seen.has(letter)) continue;
    seen.add(letter);
    result.push(letter);
  }
  return result;
}

export function matchesExcluded(
  guard: VolumeGuard,
  volume: { letter?: string | null; mountPaths?: readonly string[]; volumeUuid?: string | null; serial?: string | null },
): boolean {
  const letter = letterKey(volume.letter) || letterKey(volume.mountPaths?.[0]?.slice(0, 2));
  if (letter && guard.excludeLetters.has(letter)) return true;
  const uuid = normalizeUuid(volume.volumeUuid);
  if (uuid && guard.excludeUuids.has(uuid)) return true;
  const serial = normalizeSerial(volume.serial);
  if (serial && guard.excludeSerials.has(serial)) return true;
  return false;
}

export async function loadVolumeGuard(filePath = process.env.SKLAD_AGENT_DISABLED || path.join(process.cwd(), "data", "drive-agent-disabled.json")): Promise<VolumeGuard> {
  try {
    return parseVolumeGuard(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVolumeGuard();
    throw error;
  }
}
