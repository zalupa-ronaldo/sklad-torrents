import { listJobs } from "@/lib/jobs/queue";
import type { JobRecord } from "@/lib/jobs/types";

export interface TransferFileView {
  fileName: string;
  size: number;
  sha256: string | null;
  hostLabel: string | null;
  sent: boolean;
}

export interface TransferView {
  id: string;
  title: string;
  direction: "send" | "receive";
  state: string;
  percent: number;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
  eta: number | null;
  fileName: string | null;
  error: string | null;
  hostLabel: string | null;
  files: TransferFileView[];
}

export async function listTransfers(): Promise<TransferView[]> {
  const jobs = await listJobs();
  return jobs.filter((job) => job.kind.startsWith("localsend.")).slice(0, 30).map(toView);
}

function toView(job: JobRecord): TransferView {
  const total = job.progress.bytesTotal;
  const done = job.progress.bytesDone;
  const elapsed = job.startedAt && job.state === "running" ? (Date.now() - job.startedAt) / 1000 : 0;
  const speed = elapsed > 0.2 && done > 0 ? done / elapsed : 0;
  const payload = job.payload as {
    hostLabel?: string;
    files?: {
      fileName?: string;
      size?: number;
      sha256?: string | null;
      hostLabel?: string | null;
      sent?: boolean;
    }[];
  };
  const files = (payload.files ?? [])
    .filter((file) => file && typeof file.fileName === "string")
    .map((file) => ({
      fileName: file.fileName || "",
      size: typeof file.size === "number" ? file.size : 0,
      sha256: file.sha256 || null,
      hostLabel: file.hostLabel || payload.hostLabel || null,
      sent: file.sent === true || Boolean(file.sha256 && job.kind === "localsend.receive"),
    }));
  return {
    id: job.id,
    title: job.title,
    direction: job.kind === "localsend.receive" ? "receive" : "send",
    state: job.state,
    percent: job.progress.percent,
    bytesDone: done,
    bytesTotal: total,
    speed,
    eta: speed > 0 && total > done ? (total - done) / speed : null,
    fileName: job.progress.fileName,
    error: job.error,
    hostLabel: payload.hostLabel || files.find((file) => file.hostLabel)?.hostLabel || null,
    files,
  };
}
