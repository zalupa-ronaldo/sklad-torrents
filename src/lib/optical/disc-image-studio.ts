/**
 * Thin argv builder for a separately installed DiscImageStudio binary.
 * Bound to upstream v1.4.2 (commit b86404f) README, CLI help, and docs.
 * Source and the binary are not vendored. License: GPL-3.0-or-later.
 *
 * Offline generation (macOS, Linux, and Windows), README.en.md:
 *   ./disc-image-studio cd-generate --input picture.png --output sample.wav --sectors 2
 *   solve — DVD image; bd-generate — complete BD-R ISO
 *   "The CLI writes image files and audio tracks that you can burn with a compatible tool."
 *
 * BD-R is single-layer only. README.en.md: "Dual-layer discs are not currently supported."
 * docs/ADDING_BLURAY.md: preset bd-r-sl-25gb, --total-sectors, --data-dir, --volume-label.
 *
 * Windows IMAPI2 live burn is the desktop app, not the macOS/Linux CLI.
 * The Windows unified CLI help lists developer commands `burn-devices` and
 * `burn-build-info`. `burn-devices` prints IMAPI2 recorders and does not write media.
 */

import { OpticalError } from "@/lib/optical/errors";

export const DISC_IMAGE_STUDIO_REPO = "https://github.com/JiaFeiMiao-K-Cat/DiscImageStudio";
export const DISC_IMAGE_STUDIO_RELEASES = "https://github.com/JiaFeiMiao-K-Cat/DiscImageStudio/releases";
export const DISC_IMAGE_STUDIO_LICENSE = "GPL-3.0-or-later";

/** CdDiscModule default for `--sectors` (standard 80 min CD). */
export const CD_DEFAULT_SECTORS = 359_849;
/** built-in preset `dvd-5-120mm`: 标准 12cm 单层 DVD. */
export const DVD_SL_TOTAL_SECTORS = 2_295_104;
/** Largest single-layer DVD total in built-in presets (ritek DVD-R). */
export const DVD_SL_MAX_SECTORS = 2_298_496;
/** built-in preset `bd-r-sl-25gb`. docs/ADDING_BLURAY.md: 12,219,392 user sectors. */
export const BD_R_SL_TOTAL_SECTORS = 12_219_392;

export type TargetPlatform = "darwin" | "win32" | "linux";
export type ArtworkAction = "export" | "burn";
export type SupportedMedium = "cd" | "dvd" | "bd-r";
export type FilePosition = "inner" | "outer";

export interface DiscImageStudioPlan {
  executable: "disc-image-studio" | "DiscImageStudio";
  args: string[];
  command: string;
  action: ArtworkAction;
  platform: TargetPlatform;
  medium: SupportedMedium;
  /** This adapter never starts a hardware write. */
  writesDisc: false;
  /** True only for Windows `burn-devices`, which lists IMAPI2 drives. */
  imapiProbe: boolean;
}

export interface PlanInput {
  platform: TargetPlatform;
  action: ArtworkAction;
  medium: string;
  artworkPath: string;
  outputPath?: string;
  dataDir?: string;
  filePosition?: FilePosition;
  volumeLabel?: string;
  sectors?: number;
  totalSectors?: number;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif"]);

export function missingBinaryMessage(): string {
  return `DiscImageStudio не найден. Установите официальную сборку: ${DISC_IMAGE_STUDIO_RELEASES}`;
}

export function normalizeMedium(medium: string): SupportedMedium {
  const value = medium.trim().toLowerCase().replace(/\s+/g, "");
  if (!value) {
    throw new OpticalError("validation", "Выберите носитель: CD, DVD или однослойный BD-R.");
  }
  if (isDualLayerBluray(value) || value.includes("двухслой") && value.includes("bd")) {
    throw new OpticalError("validation", 
      "Двухслойный BD DiscImageStudio не поддерживает. В документации только однослойный BD-R 25 ГБ. Носитель отклонён до постановки в очередь.",
    );
  }
  if (isDvdDualLayer(value)) {
    throw new OpticalError("validation", 
      "DVD-DL для рисунка на поверхности не поддерживается: встроенные пресеты и модель DVD-R однослойные (DVD-5). Носитель отклонён до постановки в очередь.",
    );
  }
  if (value === "cd" || value === "cd-r" || value === "cdr") return "cd";
  if (value === "dvd" || value === "dvd-r" || value === "dvd+r" || value === "dvdr" || value === "dvd-5" || value === "dvd5") {
    return "dvd";
  }
  if (
    value === "bd-r" ||
    value === "bdr" ||
    value === "bd-r-sl" ||
    value === "bd-r-25" ||
    value === "bd25" ||
    value === "bd" ||
    value === "bluray" ||
    value === "blu-ray"
  ) {
    return "bd-r";
  }
  throw new OpticalError("validation", "Носитель не поддерживается. Выберите CD, DVD или однослойный BD-R.");
}

export function buildDiscImageStudioPlan(input: PlanInput): DiscImageStudioPlan {
  const medium = normalizeMedium(input.medium);
  const platform = assertPlatform(input.platform);
  const action = assertAction(input.action);
  if (action === "burn") {
    if (platform !== "win32") {
      throw new OpticalError("validation", 
        "На macOS и Linux DiscImageStudio только собирает офлайн-образ. Живая запись через IMAPI2 в этой интеграции не ставится в очередь.",
      );
    }
    // UnifiedCommandRunner help: developer command `burn-devices` (IMAPI2 enumeration, not a write).
    return {
      executable: "DiscImageStudio",
      args: ["burn-devices"],
      command: "burn-devices",
      action: "burn",
      platform,
      medium,
      writesDisc: false,
      imapiProbe: true,
    };
  }

  const artwork = requireArtwork(input.artworkPath);
  const output = requirePath(input.outputPath, "Укажите путь готового образа.");
  const dataDir = optionalPath(input.dataDir);
  const position = readPosition(input.filePosition, Boolean(dataDir));
  if (medium === "cd") return cdPlan(platform, artwork, output, dataDir, position, input);
  if (medium === "dvd") return dvdPlan(platform, artwork, output, dataDir, position, input);
  return bdPlan(platform, artwork, output, dataDir, position, input);
}

export function commandLine(plan: DiscImageStudioPlan): string[] {
  return [plan.executable, ...plan.args];
}

function cdPlan(
  platform: TargetPlatform,
  artwork: string,
  output: string,
  dataDir: string | null,
  position: FilePosition,
  input: PlanInput,
): DiscImageStudioPlan {
  const sectors = input.sectors ?? CD_DEFAULT_SECTORS;
  if (!Number.isInteger(sectors) || sectors <= 0) {
    throw new OpticalError("validation", "Число секторов CD должно быть целым и больше нуля.");
  }
  const args = ["cd-generate", "--input", artwork, "--output", output, "--sectors", String(sectors)];
  if (dataDir) {
    args.push("--data-dir", dataDir, "--volume-label", label(input.volumeLabel, "CD_IMAGE"), "--file-position", position);
  }
  return plan("disc-image-studio", args, "cd-generate", platform, "cd");
}

function dvdPlan(
  platform: TargetPlatform,
  artwork: string,
  output: string,
  dataDir: string | null,
  position: FilePosition,
  input: PlanInput,
): DiscImageStudioPlan {
  const total = input.totalSectors ?? DVD_SL_TOTAL_SECTORS;
  if (!Number.isInteger(total) || total <= 0 || total % 16 !== 0) {
    throw new OpticalError("validation", "Число секторов DVD должно быть кратно 16: так устроен --fill-sectors в справке solve.");
  }
  if (total > DVD_SL_MAX_SECTORS) {
    throw new OpticalError("validation", 
      "DVD-DL для рисунка на поверхности не поддерживается: запрошенный объём больше однослойных пресетов DVD-5. Носитель отклонён до постановки в очередь.",
    );
  }
  const args = ["solve", "--image", artwork, "--iso-output", output, "--total-sectors", String(total)];
  if (dataDir) {
    // Hybrid mode rejects an explicit --fill-sectors; the solver sizes the drawing range itself.
    args.push("--data-dir", dataDir, "--volume-label", label(input.volumeLabel, "DVD_IMAGE"), "--file-position", position);
  } else {
    args.push("--fill-sectors", String(total));
  }
  return plan("disc-image-studio", args, "solve", platform, "dvd");
}

function bdPlan(
  platform: TargetPlatform,
  artwork: string,
  output: string,
  dataDir: string | null,
  position: FilePosition,
  input: PlanInput,
): DiscImageStudioPlan {
  const total = input.totalSectors ?? BD_R_SL_TOTAL_SECTORS;
  if (!Number.isInteger(total) || total <= 0 || total % 32 !== 0) {
    throw new OpticalError("validation", "Число секторов BD-R должно быть кратно 32. Так требует bd-generate.");
  }
  if (total > BD_R_SL_TOTAL_SECTORS) {
    throw new OpticalError("validation", 
      "Двухслойный BD DiscImageStudio не поддерживает. В документации только однослойный BD-R 25 ГБ (12 219 392 сектора). Носитель отклонён до постановки в очередь.",
    );
  }
  const args = [
    "bd-generate",
    "--input",
    artwork,
    "--output",
    output,
    "--preset",
    "bd-r-sl-25gb",
    "--total-sectors",
    String(total),
  ];
  if (dataDir) {
    args.push("--data-dir", dataDir, "--volume-label", label(input.volumeLabel, "BD_IMAGE"), "--file-position", position);
  }
  return plan("disc-image-studio", args, "bd-generate", platform, "bd-r");
}

function plan(
  executable: DiscImageStudioPlan["executable"],
  args: string[],
  command: string,
  platform: TargetPlatform,
  medium: SupportedMedium,
): DiscImageStudioPlan {
  return {
    executable,
    args,
    command,
    action: "export",
    platform,
    medium,
    writesDisc: false,
    imapiProbe: false,
  };
}

function assertPlatform(platform: string): TargetPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  throw new OpticalError("validation", "Выберите систему задачи: macOS, Linux или Windows.");
}

function assertAction(action: string): ArtworkAction {
  if (action === "export" || action === "burn") return action;
  throw new OpticalError("validation", "Выберите действие: собрать офлайн-образ или, на Windows, поставить в очередь IMAPI2.");
}

function requireArtwork(value: string | undefined): string {
  const artwork = requirePath(value, "Укажите файл рисунка: из каталога или путь к картинке.");
  const extension = extensionOf(artwork);
  if (extension && !IMAGE_EXTENSIONS.has(extension)) {
    throw new OpticalError("validation", "DiscImageStudio читает PNG, JPEG, BMP и GIF. Другой тип файла для рисунка не подойдёт.");
  }
  return artwork;
}

function requirePath(value: string | undefined, message: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new OpticalError("validation", message);
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new OpticalError("validation", "В пути не должно быть перевода строки.");
  }
  return trimmed;
}

function optionalPath(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return requirePath(trimmed, "Путь пустой.");
}

function readPosition(position: FilePosition | undefined, hasData: boolean): FilePosition {
  const value = position ?? "inner";
  if (value !== "inner" && value !== "outer") {
    throw new OpticalError("validation", "Положение файлов: inner или outer.");
  }
  if (value === "outer" && !hasData) {
    throw new OpticalError("validation", "Внешнее кольцо доступно только вместе с папкой файлов (--data-dir).");
  }
  return value;
}

function label(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.length > 32 || /[\0\r\n]/.test(trimmed)) {
    throw new OpticalError("validation", "Метка тома слишком длинная или содержит перевод строки.");
  }
  return trimmed;
}

function extensionOf(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function isDualLayerBluray(value: string): boolean {
  if (value === "bd-dl" || value === "bd-r-dl" || value === "bdxl" || value === "bd50" || value === "bd-r-50") return true;
  return /(bluray|blu-ray|bd-r|bdr|bd).*(dl|dual|50gb|50g|bdxl)/.test(value);
}

function isDvdDualLayer(value: string): boolean {
  if (value === "dvd-dl" || value === "dvd+r-dl" || value === "dvd9" || value === "dvd-9" || value === "dvd+dl") return true;
  return value.startsWith("dvd") && /(dl|dual|dvd-?9)/.test(value);
}
