import type { ContentKind, Filesystem, JobKind, JobState } from "@/lib/kernel/types";

export const KIND_LABEL: Record<ContentKind, string> = {
  "game-pc": "Игра, ПК",
  "game-console": "Игра, консоль",
  "game-psp": "Игра, PSP",
  "game-other": "Игра, другое",
  movie: "Фильм",
  series: "Сериал",
  music: "Музыка",
  software: "Софт",
  document: "Документы",
  other: "Другое",
};

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  index: "Индексация",
  copy: "Копирование",
  move: "Перенос",
  compact: "Сжатие NTFS",
  transcode: "HandBrake",
  "delete-source": "Удаление исходника",
};

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "В очереди",
  running: "Выполняется",
  paused: "Пауза",
  done: "Готово",
  error: "Ошибка",
};

export const FS_LABEL: Record<Filesystem, string> = {
  ntfs: "NTFS",
  apfs: "APFS",
  hfs: "HFS",
  exfat: "exFAT",
  other: "Другая ФС",
};

export const CONTENT_KINDS = Object.keys(KIND_LABEL) as ContentKind[];
