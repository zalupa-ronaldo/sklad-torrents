import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { windowsVolumeLetter } from "@/lib/transcode/encode-plan";

const SHA = /^[a-f0-9]{64}$/;

export function sampleSpeed(prevBytes: number, nextBytes: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || nextBytes < prevBytes) return 0;
  return Math.round(((nextBytes - prevBytes) * 1000) / elapsedMs);
}

export function queuePercent(items: readonly { percent: number }[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.percent) ? item.percent : 0), 0);
  return Math.max(0, Math.min(100, Math.round(total / items.length)));
}

/** Pause is between files. An unfinished output is dropped. The source is not. */
export function pauseAtFile(paused: boolean): { publish: boolean; discardPartial: boolean; touchSource: false } {
  if (!paused) return { publish: true, discardPartial: false, touchSource: false };
  return { publish: false, discardPartial: true, touchSource: false };
}

export function mayReplaceOriginal(input: {
  replaceOriginal: boolean;
  verified: boolean;
  durationOk: boolean;
  tracksOk: boolean;
  decodeOk: boolean;
  sourceSha256: string;
  outputSha256: string;
}): { replace: boolean; reason: string } {
  if (!input.replaceOriginal) return { replace: false, reason: "Владелец не включил замену оригинала. Исходник остаётся." };
  if (!input.verified || !input.durationOk || !input.tracksOk || !input.decodeOk) {
    return { replace: false, reason: "Длительность, дорожки или воспроизведение не подтверждены. Исходник не заменяется." };
  }
  if (!SHA.test(input.sourceSha256) || !SHA.test(input.outputSha256)) {
    return { replace: false, reason: "Нет SHA-256 исходника и результата. Замена не начинается." };
  }
  return { replace: true, reason: "Проверки прошли, оба хэша записаны, владелец включил замену." };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Swap a verified output onto the source path. The backup is removed only after
 * the new bytes hash to the recorded output. A failed step puts the backup back.
 */
export async function replaceOriginalFile(input: {
  source: string;
  output: string;
  sourceSha256: string;
  outputSha256: string;
  allow: boolean;
}): Promise<{ replaced: boolean; reason: string }> {
  if (!input.allow) return { replaced: false, reason: "Замена выключена. Исходник остаётся." };
  const letter = windowsVolumeLetter(input.source);
  if (letter === "E" || letter === "Z") return { replaced: false, reason: "E и Z не заменяются." };
  const source = path.resolve(input.source);
  const output = path.resolve(input.output);
  if (source === output) return { replaced: false, reason: "Исходник и результат — один путь. Замена не делается." };
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) return { replaced: false, reason: "Заменяется только обычный файл." };
  const sourceNow = await sha256(source);
  const outputNow = await sha256(output);
  if (sourceNow !== input.sourceSha256 || outputNow !== input.outputSha256) {
    return { replaced: false, reason: "Файл на диске не совпал с записанным SHA-256. Замена не делается." };
  }
  const next = `${source}.sklad-next`;
  const backup = `${source}.sklad-bak`;
  await copyFile(output, next);
  if ((await sha256(next)) !== input.outputSha256) {
    await rm(next, { force: true });
    return { replaced: false, reason: "Копия результата не совпала с SHA-256. Исходник не тронут." };
  }
  await rename(source, backup);
  try {
    await rename(next, source);
    if ((await sha256(source)) !== input.outputSha256) throw new Error("hash");
    await rm(backup, { force: true });
    const left = await stat(source);
    if (!left.isFile() || left.size <= 0) throw new Error("empty");
    return { replaced: true, reason: "Оригинал заменён проверенным результатом. Резервная копия снята после совпадения SHA-256." };
  } catch {
    await rm(source, { force: true }).catch(() => undefined);
    await rename(backup, source).catch(() => undefined);
    await rm(next, { force: true }).catch(() => undefined);
    return { replaced: false, reason: "Замена не дошла до конца. Исходник возвращён из резервной копии." };
  }
}
