export const CONTENT_KINDS = ["game", "movie", "series", "music", "software", "document", "other"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const GAME_SUBTYPES = ["pc", "console", "psp", "other"] as const;
export type GameSubtype = (typeof GAME_SUBTYPES)[number];

export type ClassifyReason = "override" | "folder" | "extension" | "name" | "unknown";

export type IndexProfile = "none" | "walk" | "ntfs-mft";
export type PostAction = "none" | "compact" | "handbrake";

export interface ContentOverride {
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
}

export interface ClassifyFile {
  name: string;
  size?: number;
}

export interface ClassifyInput {
  name: string;
  savePath?: string;
  files?: ClassifyFile[];
  override?: ContentOverride | null;
}

export interface Classification {
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
  reason: ClassifyReason;
  detail: string;
}

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === "string" && (CONTENT_KINDS as readonly string[]).includes(value);
}

export function isGameSubtype(value: unknown): value is GameSubtype {
  return typeof value === "string" && (GAME_SUBTYPES as readonly string[]).includes(value);
}
