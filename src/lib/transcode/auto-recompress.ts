import path from "node:path";

import { assertEncodePaths } from "@/lib/transcode/encode-plan";

const VIDEO = /\.(mkv|mp4|m4v)$/i;

export interface AutoRecompressJob {
  source: string;
  destination: string;
  /** Copied from the panel. The worker still replaces only after duration, tracks, and decode. */
  replaceOriginal: boolean;
}

/** Queue a new file beside the source. The source path is never the destination. */
export function planAutoRecompress(files: readonly string[], replaceOriginal = false): {
  jobs: AutoRecompressJob[];
  skipped: { path: string; reason: string }[];
} {
  const jobs: AutoRecompressJob[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of files) {
    try {
      assertEncodePaths([file]);
    } catch (error) {
      skipped.push({ path: file, reason: error instanceof Error ? error.message : "Путь закрыт." });
      continue;
    }
    if (!VIDEO.test(file)) {
      skipped.push({ path: file, reason: "Это не видео .mkv, .mp4 или .m4v. Пережатие не ставится." });
      continue;
    }
    const destination = siblingOutput(file);
    if (destination === file) {
      skipped.push({ path: file, reason: "Нельзя записать результат поверх исходника." });
      continue;
    }
    jobs.push({ source: file, destination, replaceOriginal: replaceOriginal === true });
  }
  return { jobs, skipped };
}

export function siblingOutput(file: string): string {
  const ext = path.extname(file);
  const base = ext ? file.slice(0, -ext.length) : file;
  return `${base}.sklad-av1.mkv`;
}
