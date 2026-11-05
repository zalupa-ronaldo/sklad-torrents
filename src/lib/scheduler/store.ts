import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";
import { emptySchedulerPrefs, torrentKey, type SchedulerPrefs } from "@/lib/scheduler/types";

export async function loadSchedulerPrefs(): Promise<SchedulerPrefs> {
  try {
    const text = await readFile(prefsPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<SchedulerPrefs>;
    return {
      order: isRecordOfStringArrays(parsed.order) ? parsed.order : {},
      priority: isRecordOfNumbers(parsed.priority) ? parsed.priority : {},
      userPaused: Array.isArray(parsed.userPaused) ? parsed.userPaused.filter((item) => typeof item === "string") : [],
    };
  } catch {
    return emptySchedulerPrefs();
  }
}

export async function saveSchedulerPrefs(prefs: SchedulerPrefs): Promise<void> {
  const file = prefsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export async function setUserPaused(hostId: string, hash: string, paused: boolean): Promise<void> {
  const prefs = await loadSchedulerPrefs();
  const key = torrentKey({ hostId, hash });
  const has = prefs.userPaused.includes(key);
  if (paused && !has) prefs.userPaused.push(key);
  if (!paused && has) prefs.userPaused = prefs.userPaused.filter((item) => item !== key);
  if (paused === has) return;
  await saveSchedulerPrefs(prefs);
}

function prefsPath(): string {
  // Kernel scheduler owns data/scheduler.json. This queue keeps its own file.
  return path.join(dataDir(), "download-queue.json");
}

function isRecordOfStringArrays(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => Array.isArray(item) && item.every((entry) => typeof entry === "string"));
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}
