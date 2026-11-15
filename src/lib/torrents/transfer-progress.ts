import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot } from "@/lib/progress/types";
import { dataDir } from "@/lib/qbittorrent/store";
import { listTransferJobs, type TransferJob } from "@/lib/torrents/transfer";

const UNKNOWN_ETA = 8_640_000;

let registered = false;

export function registerTorrentTransferProgress(): void {
  if (registered) return;
  registered = true;
  registerJobSource({
    id: "torrent-transfer",
    list: async () => (await listTransferJobs(dataDir())).map(transferJobSnapshot),
  });
}

export function transferJobSnapshot(job: TransferJob): JobSnapshot {
  const totalBytes = job.files.reduce((sum, file) => sum + file.size, 0);
  const processedBytes = job.files.reduce((sum, file) => sum + Math.min(file.size, file.copiedBytes), 0);
  const progress = totalBytes > 0 ? Math.min(1, processedBytes / totalBytes) : job.status === "completed" ? 1 : 0;
  const speed = job.status === "running" && job.bytesThisWindow > 0 ? job.bytesThisWindow : 0;
  const terminal = job.status === "completed" || job.status === "cancelled" || job.status === "error";
  const current = job.files.find((file) => file.copiedBytes < file.size);
  return {
    id: `torrent-transfer__${job.id}`,
    kind: "copy",
    title: job.name,
    status: job.status,
    progress,
    processedBytes,
    totalBytes,
    speed,
    eta: speed > 0 ? Math.ceil(Math.max(0, totalBytes - processedBytes) / speed) : UNKNOWN_ETA,
    currentFile: current?.relativeName ?? null,
    host: job.hostId,
    diskLabel: null,
    outputPath: job.destRoot,
    error: job.error,
    capabilities: {
      pause: job.status === "queued" || job.status === "running",
      resume: job.status === "paused",
      cancel: !terminal,
    },
    pauseUnsupportedReason: null,
    updatedAt: job.updatedAt,
  };
}
