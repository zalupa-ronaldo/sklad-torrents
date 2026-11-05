import type { JobHost, JobKind, JobState } from "@/lib/jobs/model";

export const KIND_LABEL: Record<JobKind, string> = {
  move: "Перенос",
  copy: "Копирование",
  index: "Индексация",
  compact: "Сжатие NTFS",
  transcode: "Перекодирование",
};

export const HOST_LABEL: Record<JobHost, string> = {
  "mac-local": "Mac mini",
  "pc-agent": "Windows-ПК",
};

export const STATE_LABEL: Record<JobState, string> = {
  queued: "В очереди",
  running: "Выполняется",
  paused: "Пауза",
  done: "Завершено",
  error: "Ошибка",
};

export const STATE_TONE: Record<JobState, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-download/15 text-download",
  paused: "bg-warn/15 text-warn",
  done: "bg-seed/15 text-seed",
  error: "bg-destructive/15 text-destructive",
};
