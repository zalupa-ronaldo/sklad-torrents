import { formatBytes, formatEta, formatPercent, formatSpeed } from "@/lib/format";
import type { JobKind, JobSnapshot, JobStatus } from "@/lib/progress/types";

const KIND_LABEL: Record<JobKind, string> = {
  torrent: "Торрент",
  index: "Индексация",
  copy: "Копирование",
  compact: "Сжатие",
  transcode: "Перекодирование",
  optical: "Рисунок на диске",
};

const STATUS_LABEL: Record<JobStatus, string> = {
  running: "Идёт",
  paused: "На паузе",
  queued: "В очереди",
  completed: "Готово",
  error: "Ошибка",
  cancelled: "Отменено",
};

const PAUSE_UNSUPPORTED = "Движок не умеет паузу";

export interface JobCardModel {
  id: string;
  href: string;
  kind: JobKind;
  kindLabel: string;
  title: string;
  status: JobStatus;
  statusLabel: string;
  percentLabel: string;
  percent: number;
  etaLabel: string;
  bytesLabel: string;
  speedLabel: string;
  currentFile: string | null;
  host: string | null;
  diskLabel: string | null;
  outputPath: string | null;
  error: string | null;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  pauseNote: string | null;
  cancelNote: string | null;
}

/** Pure view of a job snapshot: labels, counters, and which buttons exist. */
export function toJobCard(snapshot: JobSnapshot): JobCardModel {
  const progress = clamp01(snapshot.progress);
  const running = snapshot.status === "running";
  const canPause = running && snapshot.capabilities.pause;
  const canResume = (snapshot.status === "paused" || snapshot.status === "queued") && snapshot.capabilities.resume;
  const canCancel =
    snapshot.capabilities.cancel &&
    (snapshot.status === "running" || snapshot.status === "paused" || snapshot.status === "queued");
  const pauseNote = running && !snapshot.capabilities.pause ? snapshot.pauseUnsupportedReason || PAUSE_UNSUPPORTED : null;
  return {
    id: snapshot.id,
    href: `/progress/${encodeURIComponent(snapshot.id)}`,
    kind: snapshot.kind,
    kindLabel: KIND_LABEL[snapshot.kind],
    title: snapshot.title,
    status: snapshot.status,
    statusLabel: statusLabel(snapshot),
    percentLabel: formatPercent(progress),
    percent: progress * 100,
    etaLabel: etaLabel(snapshot),
    bytesLabel: `${formatBytes(snapshot.processedBytes)} из ${formatBytes(snapshot.totalBytes)}`,
    speedLabel: formatSpeed(snapshot.speed),
    currentFile: snapshot.currentFile,
    host: snapshot.host,
    diskLabel: snapshot.diskLabel,
    outputPath: snapshot.outputPath,
    error: snapshot.error,
    canPause,
    canResume,
    canCancel,
    pauseNote,
    cancelNote: snapshot.status === "cancelled" ? "Остановлено. Файлы на диске не удалялись." : null,
  };
}

export function toJobCards(snapshots: JobSnapshot[]): JobCardModel[] {
  return snapshots.map((snapshot) => toJobCard(snapshot));
}

function statusLabel(snapshot: JobSnapshot): string {
  if (snapshot.kind === "torrent" && snapshot.status === "running" && snapshot.progress >= 0.999) return "Раздача";
  return STATUS_LABEL[snapshot.status];
}

function etaLabel(snapshot: JobSnapshot): string {
  if (snapshot.status === "completed") return "готово";
  if (snapshot.status === "paused") return "на паузе";
  if (snapshot.status === "queued") return "ждёт слот";
  if (snapshot.status === "error" || snapshot.status === "cancelled") return "—";
  const eta = formatEta(snapshot.eta);
  return eta === "—" ? "осталось —" : `осталось ${eta}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
