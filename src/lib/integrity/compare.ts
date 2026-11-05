import type { HashFileRecord, IntegrityJob } from "@/lib/integrity/types";

const FINISHED: HashFileRecord["status"][] = ["match", "mismatch", "error", "recorded"];

export function isHashed(file: HashFileRecord): boolean {
  return FINISHED.includes(file.status) && file.sha256.length === 64;
}

export function filesDone(files: HashFileRecord[]): number {
  return files.filter((file) => isHashed(file) || file.status === "error").length;
}

export function applyComparison(job: IntegrityJob): void {
  job.mismatchPaths = [];
  if (!job.comparable) {
    for (const file of job.files) {
      if (file.sha256) file.status = "recorded";
    }
    job.error = null;
    return;
  }
  if (job.kind === "localsend" && !job.transferDone) {
    for (const file of job.files) {
      if (file.sha256) file.status = "recorded";
    }
    job.error = null;
    return;
  }
  const sources = job.files.filter((file) => file.side === "source");
  const destinations = job.files.filter((file) => file.side === "destination");
  const byDest = new Map(destinations.map((file) => [file.relativePath, file]));
  for (const source of sources) {
    const dest = byDest.get(source.relativePath);
    if (!source.sha256) {
      source.status = source.status === "error" ? "error" : "pending";
      continue;
    }
    if (!dest || dest.status === "error" || !dest.sha256) {
      source.status = "mismatch";
      if (dest && dest.status !== "error") dest.status = "mismatch";
      job.mismatchPaths.push(source.relativePath);
      continue;
    }
    if (source.size !== dest.size || source.sha256 !== dest.sha256) {
      source.status = "mismatch";
      dest.status = "mismatch";
      job.mismatchPaths.push(source.relativePath);
      continue;
    }
    source.status = "match";
    dest.status = "match";
  }
  for (const dest of destinations) {
    if (!sources.some((source) => source.relativePath === dest.relativePath)) {
      dest.status = "mismatch";
      job.mismatchPaths.push(dest.relativePath);
    }
  }
  job.mismatchPaths = [...new Set(job.mismatchPaths)];
  if (job.kind === "compact" && job.mismatchPaths.length > 0) {
    job.error = "Сжатие NTFS изменило логические байты. Это ошибка целостности, не успешное сжатие.";
  } else if (job.kind === "optical" && job.mismatchPaths.length > 0) {
    job.error = "Проверка диска не сошлась. Запись в каталог проверенных дисков не добавляется.";
  } else if (job.mismatchPaths.length > 0) {
    job.error = null;
  } else if (job.files.some((file) => file.status === "error")) {
    job.error = job.error || "Не удалось прочитать файл для SHA-256.";
  } else {
    job.error = null;
  }
}

export function deletionDecision(job: IntegrityJob): { deleteAllowed: boolean; reason: string } {
  if (!job.comparable || job.kind === "handbrake") {
    return {
      deleteAllowed: false,
      reason: "Перекодирование меняет байты. Хэши входа и выхода не сравниваются и не открывают удаление исходника.",
    };
  }
  if (job.kind === "optical") {
    return {
      deleteAllowed: false,
      reason: "Носитель не стирается автоматически, в том числе перезаписываемый.",
    };
  }
  if (job.kind === "torrent") {
    return { deleteAllowed: false, reason: "Хэш раздачи ничего не удаляет." };
  }
  if (job.kind === "localsend" && !job.transferDone) {
    return { deleteAllowed: false, reason: "Передача LocalSend ещё не завершена. Совпадение не ставится." };
  }
  const bad = job.files.filter((file) => file.status === "mismatch" || file.status === "error");
  if (bad.length > 0) {
    const names = [...new Set(bad.map((file) => file.relativePath))];
    return {
      deleteAllowed: false,
      reason: `Отличается: ${names.join(", ")}. Удаление исходных файлов выключено.`,
    };
  }
  if (job.state !== "done" || job.files.length === 0 || job.files.some((file) => file.status !== "match")) {
    return { deleteAllowed: false, reason: "Сверка SHA-256 ещё не закончена." };
  }
  if (!job.userConfirmed) {
    return {
      deleteAllowed: false,
      reason: "Нужно отдельное подтверждение. Совпадение хэшей само ничего не удаляет.",
    };
  }
  return { deleteAllowed: true, reason: "" };
}
