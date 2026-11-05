import type { ContentKind, CustomRule } from "@/lib/kernel/types";

export interface ClassifyInput {
  name: string;
  path?: string;
  files?: { name: string }[];
  override?: ContentKind | null;
  /** Present so callers can pass it. Classification never reads it. */
  sizeBytes?: number;
  customRules?: CustomRule[];
}

export interface Classified {
  kind: ContentKind;
  reason: string;
}

const EXT_RE = /\.([a-z0-9]{1,8})$/i;

function extensionsOf(names: string[]): Set<string> {
  const found = new Set<string>();
  for (const name of names) {
    const match = name.match(EXT_RE);
    if (match?.[1]) found.add(match[1].toLowerCase());
  }
  return found;
}

function hasExt(exts: Set<string>, list: string[]): boolean {
  return list.some((item) => exts.has(item));
}

/**
 * User override, then custom rules, then extensions and name.
 * `sizeBytes` is accepted and ignored.
 */
export function classify(input: ClassifyInput): Classified {
  if (input.override) {
    return { kind: input.override, reason: "Задано вручную. Расширения и размер не учитывались." };
  }

  const names = [input.name, input.path ?? "", ...(input.files ?? []).map((file) => file.name)];
  const haystack = names.join("\n");
  const text = haystack.toLowerCase();

  for (const rule of input.customRules ?? []) {
    const pattern = rule.pattern.trim().toLowerCase();
    if (pattern && text.includes(pattern)) {
      return { kind: rule.kind, reason: `Своё правило «${rule.pattern}».` };
    }
  }

  const exts = extensionsOf(names);

  if (/\bpsp\b/.test(text) || /ulus|ules|ucus|uces/.test(text)) {
    return { kind: "game-psp", reason: "В имени или файлах есть PSP или код диска PSP." };
  }
  if (
    hasExt(exts, ["nsp", "xci", "cia", "wad", "rvz", "gcm", "wbfs", "cso", "3ds", "nds"]) ||
    /(nintendo|switch|playstation|\bps[1-5]\b|xbox|\bwii\b)/.test(text)
  ) {
    return { kind: "game-console", reason: "Расширение или имя указывает на консольную игру." };
  }
  if (/s\d{1,2}e\d{1,2}/.test(text) || /season\s*\d/.test(text) || /сезон\s*\d/.test(text)) {
    return { kind: "series", reason: "В имени номер серии или сезона." };
  }
  if (/\bost\b|soundtrack|саундтрек/.test(text) || hasExt(exts, ["flac", "mp3", "aac", "ogg", "wav", "m4a", "alac"])) {
    return { kind: "music", reason: "Аудиорасширение или пометка саундтрека." };
  }
  const video = hasExt(exts, ["mkv", "mp4", "avi", "m4v", "webm"]);
  const movieMark = /(19|20)\d{2}/.test(text) || /2160p|1080p|720p|\buhd\b|bluray|blu-ray/.test(text);
  if (video && movieMark) {
    return { kind: "movie", reason: "Видеофайл и год или разрешение в имени." };
  }
  if (/ultimate edition|game of the year|deluxe edition|remastered|\brepack\b|fitgirl/.test(text)) {
    return { kind: "game-pc", reason: "Имя похоже на издание ПК-игры." };
  }
  if (/(ubuntu|debian|fedora|linux|windows).{0,40}(iso|desktop|amd64)|\.msi\b/.test(text) || hasExt(exts, ["msi", "dmg", "pkg", "deb", "rpm", "appimage"])) {
    return { kind: "software", reason: "Установщик или образ системы." };
  }
  if (hasExt(exts, ["exe", "apk"]) && !video) {
    return { kind: "software", reason: "Исполняемый файл без признаков игры в имени." };
  }
  if (hasExt(exts, ["pdf", "doc", "docx", "txt", "epub", "rtf", "xls", "xlsx", "djvu"])) {
    return { kind: "document", reason: "Расширение документа." };
  }
  return { kind: "other", reason: "Нет правила по имени и расширению. Размер не используется." };
}
