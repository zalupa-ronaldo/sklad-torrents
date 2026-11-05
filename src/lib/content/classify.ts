import type { Classification, ClassifyInput, GameSubtype } from "@/lib/content/types";
import { isContentKind, isGameSubtype } from "@/lib/content/types";

const VIDEO = new Set(["mkv", "mp4", "avi", "m4v", "webm", "mov", "ts", "m2ts", "wmv", "mpg", "mpeg"]);
const AUDIO = new Set(["flac", "mp3", "wav", "aac", "ogg", "m4a", "alac", "ape", "opus", "wma"]);
const DOCUMENT = new Set(["pdf", "epub", "djvu", "mobi", "fb2", "doc", "docx", "rtf"]);
const INSTALLER = new Set(["msi", "dmg", "deb", "rpm", "apk", "pkg", "appimage", "msix"]);
const SIDECAR = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "nfo",
  "txt",
  "srt",
  "sub",
  "ass",
  "idx",
  "url",
  "ini",
  "md",
  "sfv",
  "md5",
  "sha1",
  "torrent",
  "diz",
  "html",
  "htm",
  "log",
  "xml",
]);

/** Disc formats that are games by themselves, not because the file is large. */
const IMPLIED_GAME: Record<string, GameSubtype> = {
  cso: "psp",
  pbp: "psp",
  wbfs: "console",
  rvz: "console",
  gcz: "console",
  nsp: "console",
  xci: "console",
  gdi: "console",
};

const SERIES_RE =
  /(^|[^a-z0-9])s\d{1,2}e\d{1,2}([^a-z0-9]|$)|сериал|(^|[^a-z0-9])series([^a-z0-9]|$)|сезон\s*\d|(^|[^a-z0-9])season\s*\d/i;
const MOVIE_RE = /фильм|кино|мультфильм|(^|[^a-z0-9])movie([^a-z0-9]|$)|(^|[^a-z0-9])film([^a-z0-9]|$)|bdrip|bluray|web-?dl|webrip/i;
const MUSIC_RE = /саундтрек|soundtrack|(^|[^a-z0-9])ost([^a-z0-9]|$)|дискографи/i;
const DOC_NAME_RE = /(^|[^a-z0-9])(pdf|epub|djvu|fb2)([^a-z0-9]|$)|книга/i;
const SOFTWARE_RE =
  /(ubuntu|debian|fedora|linux\s*mint|blender|дистрибутив|установщик|installer|portable|(^|[^a-z0-9])amd64([^a-z0-9]|$)|x86_64|(^|[^a-z0-9])x64(?![0-9a-z]))/i;
const CONSOLE_RE =
  /(playstation\s*2|(^|[^a-z0-9])ps2([^a-z0-9]|$)|(^|[^a-z0-9])psx([^a-z0-9]|$)|(^|[^a-z0-9])ps[1345]([^a-z0-9]|$)|switch|xbox|wiiu|(^|[^a-z0-9])wii([^a-z0-9]|$)|(^|[^a-z0-9])3ds([^a-z0-9]|$)|(^|[^a-z0-9])nds([^a-z0-9]|$)|dreamcast|gamecube|(^|[^a-z0-9])sega([^a-z0-9]|$))/i;

export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function classify(input: ClassifyInput): Classification {
  const override = normalizeOverride(input.override);
  if (override) {
    return {
      kind: override.kind,
      gameSubtype: override.kind === "game" ? (override.gameSubtype ?? "other") : null,
      reason: "override",
      detail: "Тип задан вручную",
    };
  }

  const fromFiles = classifyByExtensions(input);
  if (fromFiles) return fromFiles;
  const fromName = classifyByName(input.name);
  if (fromName) return fromName;

  return {
    kind: "other",
    gameSubtype: null,
    reason: "unknown",
    detail: "Нет уверенного признака. Размер файла сам по себе тип не задаёт",
  };
}

function normalizeOverride(override: ClassifyInput["override"]): ClassifyInput["override"] {
  if (!override || !isContentKind(override.kind)) return null;
  const gameSubtype = override.kind === "game" && isGameSubtype(override.gameSubtype) ? override.gameSubtype : null;
  return { kind: override.kind, gameSubtype: override.kind === "game" ? (gameSubtype ?? "other") : null };
}

function classifyByExtensions(input: ClassifyInput): Classification | null {
  const files = input.files ?? [];
  if (files.length === 0) return null;

  let video = 0;
  let audio = 0;
  let document = 0;
  let installer = 0;
  let bulk = 0;
  let hasCue = false;
  let hasIso = false;
  let hasExe = false;
  let implied: GameSubtype | null = null;
  const fileNames: string[] = [];

  for (const file of files) {
    const ext = fileExtension(file.name);
    if (!ext || SIDECAR.has(ext)) continue;
    const weight = file.size && file.size > 0 ? file.size : 1;
    fileNames.push(file.name);
    if (VIDEO.has(ext)) video += weight;
    else if (AUDIO.has(ext)) audio += weight;
    else if (DOCUMENT.has(ext)) document += weight;
    else if (INSTALLER.has(ext)) installer += weight;
    else {
      bulk += weight;
      if (ext === "cue") hasCue = true;
      else if (ext === "iso") hasIso = true;
      else if (ext === "exe") hasExe = true;
      const hinted = IMPLIED_GAME[ext];
      if (hinted) implied = implied === "psp" ? "psp" : hinted;
    }
  }

  if (fileNames.length === 0 && implied === null) return null;

  if (implied) {
    return game(implied, implied === "psp" ? "Образ PSP (cso/pbp) или другой игровой формат" : "Игровой образ (gdi, nsp и похожие)");
  }

  const hintText = [input.name, input.savePath ?? "", ...fileNames].join("\n");
  const platform = platformHint(hintText);
  const library = hasGameLibrary(hintText);
  const softwareAgrees = SOFTWARE_RE.test(hintText);

  if (majority(video, bulk, [audio, document, installer])) {
    const series = SERIES_RE.test(hintText);
    return {
      kind: series ? "series" : "movie",
      gameSubtype: null,
      reason: "extension",
      detail: series ? "Видео и номер серии вроде S01E02" : "Видеофайл, без номера серии",
    };
  }
  if (majority(audio, bulk, [video, document, installer])) {
    return { kind: "music", gameSubtype: null, reason: "extension", detail: "Аудиофайлы (flac, mp3 и похожие)" };
  }
  if (majority(document, bulk, [video, audio, installer])) {
    return { kind: "document", gameSubtype: null, reason: "extension", detail: "Документы: pdf, epub или djvu" };
  }
  if (majority(installer, bulk, [video, audio, document])) {
    return { kind: "software", gameSubtype: null, reason: "extension", detail: "Установщик (msi, dmg и похожие)" };
  }

  const discOrExe = hasIso || hasCue || hasExe;
  if (discOrExe && (platform === "psp" || platform === "console")) {
    return game(platform, platform === "psp" ? "Образ и признак PSP в имени или каталоге" : "Образ и признак консоли");
  }
  if ((hasExe || hasIso || hasCue) && library && !(softwareAgrees && (hasIso || hasExe) && platform !== "psp")) {
    return game(platform === "console" || platform === "psp" ? platform : "pc", "Каталог игровой библиотеки");
  }
  if ((hasIso || hasExe) && softwareAgrees && platform !== "psp" && platform !== "console") {
    return {
      kind: "software",
      gameSubtype: null,
      reason: "extension",
      detail: "Имя и расширение сходятся на программу, не на игру",
    };
  }

  return null;
}

function classifyByName(name: string): Classification | null {
  const text = name.trim();
  if (!text) return null;
  if (SERIES_RE.test(text)) {
    return { kind: "series", gameSubtype: null, reason: "name", detail: "В имени номер серии или слово «сериал»" };
  }
  if (MOVIE_RE.test(text)) {
    return { kind: "movie", gameSubtype: null, reason: "name", detail: "В имени слово вроде «фильм» или movie" };
  }
  if (MUSIC_RE.test(text)) {
    return { kind: "music", gameSubtype: null, reason: "name", detail: "В имени саундтрек или soundtrack" };
  }
  const platform = platformHint(text);
  if (platform === "psp" || platform === "console") {
    return game(platform, platform === "psp" ? "В имени есть PSP" : "В имени указана консоль", "name");
  }
  if (SOFTWARE_RE.test(text)) {
    return { kind: "software", gameSubtype: null, reason: "name", detail: "В имени дистрибутив или установщик" };
  }
  if (DOC_NAME_RE.test(text)) {
    return { kind: "document", gameSubtype: null, reason: "name", detail: "В имени документ или книга" };
  }
  return null;
}

function game(subtype: GameSubtype, detail: string, reason: Classification["reason"] = "extension"): Classification {
  return { kind: "game", gameSubtype: subtype, reason, detail };
}

function majority(bytes: number, bulk: number, rivals: number[]): boolean {
  if (bytes <= 0) return false;
  if (bytes < bulk) return false;
  return rivals.every((rival) => bytes >= rival);
}

function platformHint(text: string): GameSubtype | null {
  if (hasToken(text, "psp")) return "psp";
  if (CONSOLE_RE.test(text)) return "console";
  if (hasToken(text, "pc") || hasGameLibrary(text)) return "pc";
  return null;
}

function hasGameLibrary(text: string): boolean {
  return /(^|[/\\])games?([/\\]|$)/i.test(text);
}

function hasToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text);
}
