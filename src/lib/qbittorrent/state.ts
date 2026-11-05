import type { NormalizedState, RawFile, RawTorrent, TorrentFileSnapshot, TorrentSnapshot } from "@/lib/qbittorrent/types";

export function normalizeState(raw: string): NormalizedState {
  switch (raw) {
    case "downloading":
    case "forcedDL":
    case "allocating":
      return "downloading";
    case "metaDL":
      return "metadata";
    case "stalledDL":
      return "stalled";
    case "pausedDL":
    case "stoppedDL":
    case "pausedUP":
    case "stoppedUP":
      return "paused";
    case "queuedDL":
    case "queuedUP":
      return "queued";
    case "uploading":
    case "forcedUP":
    case "stalledUP":
      return "seeding";
    case "checkingDL":
    case "checkingUP":
    case "checkingResumeData":
      return "checking";
    case "moving":
      return "moving";
    case "error":
      return "error";
    case "missingFiles":
      return "missing";
    default:
      return "unknown";
  }
}

export function isDownloadRawState(raw: string): boolean {
  return /DL$/.test(raw) || raw === "downloading" || raw === "allocating";
}

export function mapRawTorrent(raw: RawTorrent): TorrentSnapshot {
  const rawState = String(raw.state || "unknown");
  const tags =
    typeof raw.tags === "string"
      ? raw.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
  return {
    hash: String(raw.hash || "").toLowerCase(),
    name: String(raw.name || "Без имени"),
    state: normalizeState(rawState),
    rawState,
    progress: numberOrZero(raw.progress),
    size: numberOrZero(raw.size),
    totalSize: numberOrZero(raw.total_size ?? raw.size),
    downloaded: numberOrZero(raw.downloaded),
    uploaded: numberOrZero(raw.uploaded),
    dlspeed: numberOrZero(raw.dlspeed),
    upspeed: numberOrZero(raw.upspeed),
    eta: numberOrZero(raw.eta),
    ratio: numberOrZero(raw.ratio),
    savePath: String(raw.save_path || ""),
    contentPath: String(raw.content_path || raw.save_path || ""),
    addedOn: numberOrZero(raw.added_on),
    completionOn: numberOrZero(raw.completion_on),
    numSeeds: numberOrZero(raw.num_seeds),
    numLeechs: numberOrZero(raw.num_leechs),
    category: String(raw.category || ""),
    tags,
  };
}

export function mapRawFile(raw: RawFile): TorrentFileSnapshot {
  return {
    index: Number.isFinite(raw.index) ? Number(raw.index) : 0,
    name: String(raw.name || ""),
    size: numberOrZero(raw.size),
    progress: numberOrZero(raw.progress),
    priority: Number.isFinite(raw.priority) ? Number(raw.priority) : 0,
  };
}

function numberOrZero(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** qBittorrent 5 / WebAPI 2.11 renamed pause/resume to stop/start. */
export function usesStopApi(webapiVersion: string): boolean {
  const [major = 0, minor = 0] = webapiVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return major > 2 || (major === 2 && minor >= 11);
}
