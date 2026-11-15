import { admitMachine, type MachineLimit } from "@/lib/transcode/workload";

export interface CompactBatch {
  files: readonly string[];
  done: readonly string[];
  paused: boolean;
  limit: MachineLimit;
  running: number;
}

/** CompactGUI pauses between files. A file that is not done is not marked done. */
export function nextCompactFile(batch: CompactBatch): { file: string | null; reason: string } {
  const gate = admitMachine(batch.limit, batch.running);
  if (batch.paused || batch.limit.paused) return { file: null, reason: "Сжатие этой машины на паузе. Следующий файл не начинается." };
  if (!gate.admit) return { file: null, reason: gate.reason || "Сжатие ждёт." };
  const finished = new Set(batch.done);
  const next = batch.files.find((file) => !finished.has(file));
  if (!next) return { file: null, reason: "Все файлы этой папки уже пройдены." };
  return { file: next, reason: "Следующий файл. Предыдущий неполный файл не помечается готовым." };
}

/** NTFS compression must not change the bytes a reader sees. */
export function compactKeptBytes(beforeSha: string, afterSha: string): { ok: boolean; reason: string } {
  if (!/^[a-f0-9]{64}$/.test(beforeSha) || beforeSha !== afterSha) {
    return { ok: false, reason: "SHA-256 файла после compact не совпал. Успех не ставится." };
  }
  return { ok: true, reason: "Содержимое файла то же. Сжатие не подменило байты." };
}
