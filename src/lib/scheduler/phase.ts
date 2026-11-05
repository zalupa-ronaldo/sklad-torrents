import type { NormalizedState } from "@/lib/qbittorrent/types";

/**
 * Download slot phases. Seeding and paused seeds never take the slot and
 * are never paused by the scheduler. Active means the torrent is currently
 * downloading, fetching metadata, stalled, or checking the download.
 */
export type DownloadPhase = "active" | "paused" | "queued" | "seeding" | "complete" | "other";

export function downloadPhase(torrent: {
  state: NormalizedState;
  rawState: string;
  progress: number;
}): DownloadPhase {
  const raw = torrent.rawState || "";
  if (torrent.state === "error" || torrent.state === "missing" || torrent.state === "unknown") return "other";
  if (isSeedRaw(raw) || torrent.state === "seeding") return "seeding";
  if (torrent.state === "moving") return "other";
  if (isFinished(torrent.progress) && !isChecking(raw, torrent.state)) return "complete";
  if (isActiveDownload(raw, torrent.state)) return "active";
  if (raw === "queuedDL" || torrent.state === "queued") return "queued";
  if (raw === "pausedDL" || raw === "stoppedDL" || torrent.state === "paused") return "paused";
  return "other";
}

function isFinished(progress: number): boolean {
  return Number.isFinite(progress) && progress >= 0.999;
}

function isSeedRaw(raw: string): boolean {
  return (
    raw === "uploading" ||
    raw === "forcedUP" ||
    raw === "stalledUP" ||
    raw === "pausedUP" ||
    raw === "stoppedUP" ||
    raw === "queuedUP" ||
    raw === "checkingUP"
  );
}

function isChecking(raw: string, state: NormalizedState): boolean {
  return state === "checking" || raw.startsWith("checking");
}

function isActiveDownload(raw: string, state: NormalizedState): boolean {
  return (
    state === "downloading" ||
    state === "metadata" ||
    state === "stalled" ||
    state === "checking" ||
    raw === "checkingDL" ||
    raw === "checkingResumeData" ||
    raw === "metaDL" ||
    raw === "stalledDL" ||
    raw === "forcedDL" ||
    raw === "allocating" ||
    raw === "downloading"
  );
}
