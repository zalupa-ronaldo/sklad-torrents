import type { ClassifyReason, ContentKind, GameSubtype, IndexProfile, PostAction } from "@/lib/content/types";

export const KIND_LABEL: Record<ContentKind, string> = {
  game: "Игра",
  movie: "Фильм",
  series: "Сериал",
  music: "Музыка",
  software: "Софт",
  document: "Документы",
  other: "Другое",
};

export const SUBTYPE_LABEL: Record<GameSubtype, string> = {
  pc: "ПК",
  console: "Консоль",
  psp: "PSP",
  other: "Другое",
};

export const REASON_LABEL: Record<ClassifyReason, string> = {
  override: "вручную",
  extension: "по расширению",
  name: "по имени",
  unknown: "не распознано",
};

export const INDEX_LABEL: Record<IndexProfile, string> = {
  none: "Не индексировать",
  walk: "Обычный обход",
  "ntfs-mft": "NTFS MFT",
};

export const POST_LABEL: Record<PostAction, string> = {
  none: "Без обработки",
  compact: "Сжатие NTFS",
  handbrake: "HandBrake",
};

export function kindLabel(kind: ContentKind, subtype: GameSubtype | null): string {
  if (kind === "game") return `Игра · ${SUBTYPE_LABEL[subtype ?? "other"]}`;
  return KIND_LABEL[kind];
}
