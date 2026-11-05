import type { ContentKind, IndexProfile, PostAction } from "@/lib/content/types";
import { CONTENT_KINDS } from "@/lib/content/types";
import { DISK_ID } from "@/lib/drives/ids";
import type { HandbrakeSettings, PolicyRules, PresetId, TypeRule } from "@/lib/policies/types";

/** Shelf ids from the drive catalog. Hardware identity stays serial + uuid. */
export const DISK_KEY = {
  vault: DISK_ID.vault,
  games: DISK_ID.gamesHdd,
  media: DISK_ID.media,
  archive: DISK_ID.offline,
} as const;

export const DEFAULT_HANDBRAKE: HandbrakeSettings = {
  presetName: "Склад · 1080p",
  qualityMode: "rf",
  quality: 20,
  container: "mkv",
};

const CINEMA_HANDBRAKE: HandbrakeSettings = {
  presetName: "Склад · кино 1080p",
  qualityMode: "rf",
  quality: 20,
  container: "mkv",
};

const SERIES_HANDBRAKE: HandbrakeSettings = {
  presetName: "Склад · сериал 1080p",
  qualityMode: "rf",
  quality: 22,
  container: "mkv",
};

export interface NamedPreset {
  id: Exclude<PresetId, "custom">;
  name: string;
  description: string;
  rules: PolicyRules;
}

function rule(
  diskId: string,
  folder: string,
  indexProfile: IndexProfile,
  postAction: PostAction,
  handbrake: HandbrakeSettings = DEFAULT_HANDBRAKE,
): TypeRule {
  return {
    diskId,
    customHostId: "",
    customPath: "",
    folder,
    indexProfile,
    postAction,
    handbrake,
  };
}

function withPost(rules: PolicyRules, post: Partial<Record<ContentKind, PostAction>>, index?: Partial<Record<ContentKind, IndexProfile>>): PolicyRules {
  const next = {} as PolicyRules;
  for (const kind of CONTENT_KINDS) {
    next[kind] = {
      ...rules[kind],
      postAction: post[kind] ?? "none",
      indexProfile: index?.[kind] ?? rules[kind].indexProfile,
      handbrake: { ...rules[kind].handbrake },
    };
  }
  return next;
}

const shelfRules: PolicyRules = {
  game: rule(DISK_KEY.games, "Games", "ntfs-mft", "compact"),
  movie: rule(DISK_KEY.media, "Cinema", "walk", "handbrake", CINEMA_HANDBRAKE),
  series: rule(DISK_KEY.media, "Series", "walk", "handbrake", SERIES_HANDBRAKE),
  music: rule(DISK_KEY.vault, "Music", "walk", "none"),
  software: rule(DISK_KEY.games, "Software", "walk", "none"),
  document: rule(DISK_KEY.media, "Documents", "walk", "none"),
  other: rule(DISK_KEY.vault, "Other", "walk", "none"),
};

export const PRESETS: Record<Exclude<PresetId, "custom">, NamedPreset> = {
  shelf: {
    id: "shelf",
    name: "Полка: игры на HDD, кино на медиадиск",
    description: "Игры на NTFS HDD с индексом MFT и сжатием после переноса. Кино и сериалы на медиадиск, HandBrake по профилю. Музыка на Vault. Пресет сам автоматику не включает.",
    rules: shelfRules,
  },
  "index-only": {
    id: "index-only",
    name: "Всё только индексировать",
    description: "Те же полки, но без HandBrake и без сжатия. На NTFS — MFT, на APFS — обычный обход.",
    rules: withPost(shelfRules, {}, {
      game: "ntfs-mft",
      movie: "walk",
      series: "walk",
      music: "walk",
      software: "ntfs-mft",
      document: "walk",
      other: "ntfs-mft",
    }),
  },
  "handbrake-cinema": {
    id: "handbrake-cinema",
    name: "Кино через HandBrake",
    description: "Фильмы и сериалы перекодируются по сохранённому профилю. Игры только индексируются, без сжатия. Остальное — индекс.",
    rules: withPost(shelfRules, { movie: "handbrake", series: "handbrake" }, {
      game: "ntfs-mft",
      movie: "walk",
      series: "walk",
      music: "walk",
      software: "walk",
      document: "walk",
      other: "walk",
    }),
  },
};

export const PRESET_LIST: NamedPreset[] = [PRESETS.shelf, PRESETS["index-only"], PRESETS["handbrake-cinema"]];

export function emptyRules(): PolicyRules {
  return structuredClone(PRESETS.shelf.rules);
}
