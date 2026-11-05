const ALGORITHMS = new Set(["LZX", "XPRESS16K", "XPRESS8K", "XPRESS4K"]);

export function buildHandBrakeArgv({ binary, inputPath, outputPath, preset }) {
  if (!binary || !preset || !inputPath || !outputPath) {
    throw httpError(400, "Нужны HandBrakeCLI, пресет, вход и выход.");
  }
  return [binary, "--preset", preset, "-i", inputPath, "-o", outputPath];
}

export function buildCompactArgv({ binary, folder, algorithm }) {
  if (!ALGORITHMS.has(algorithm)) throw httpError(400, "Неизвестный алгоритм сжатия.");
  const target = assertNtfsFolder(folder);
  return [binary || "C:\\Windows\\System32\\compact.exe", "/C", `/EXE:${algorithm}`, `/S:${target}`];
}

export function assertNtfsFolder(folder) {
  const raw = String(folder || "").trim();
  if (!raw) throw httpError(400, "Укажите папку для сжатия.");
  if (isApfsPath(raw)) {
    throw httpError(400, "Только Windows, NTFS. Нельзя сжимать APFS, в том числе /Volumes/vault.");
  }
  const normalized = normalizeWin(raw);
  if (!/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
    throw httpError(400, "Только Windows, NTFS. Нужен путь с буквой диска или UNC.");
  }
  return normalized;
}

export function assertWindowsPath(folder, label) {
  const raw = String(folder || "").trim();
  if (!raw) throw httpError(400, `Укажите ${label}.`);
  if (isApfsPath(raw)) throw httpError(400, "Агент принимает только пути Windows, не APFS.");
  const normalized = normalizeWin(raw);
  if (!/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
    throw httpError(400, "На Windows путь выглядит как D:\\Games.");
  }
  return normalized;
}

export function normalizeWin(input) {
  const trimmed = String(input || "").trim();
  const unc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
  let folder = trimmed.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
  if (unc) folder = `\\\\${folder.replace(/^\\+/, "")}`;
  if (/^[A-Za-z]:\\$/.test(folder)) return folder;
  return folder.replace(/\\+$/, "");
}

export function isApfsPath(folder) {
  const value = String(folder || "").trim().replace(/\\/g, "/");
  if (value.startsWith("//")) return false;
  return value.startsWith("/");
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function advanceMock(job) {
  if (job.state === "failed" || job.state === "completed" || job.state === "awaiting-confirm") return job;
  job.spawned = false;
  if (job.kind === "transcode") return advanceTranscode(job);
  if (job.kind === "compress") return advanceCompress(job);
  return advanceMove(job);
}

function advanceTranscode(job) {
  if (job.state === "queued") {
    job.state = "running";
    job.progress = 0.34;
    return job;
  }
  if (job.progress < 0.67) {
    job.progress = 0.67;
    return job;
  }
  job.state = "completed";
  job.progress = 1;
  job.outputMarker = `mock-output:${job.outputPath}`;
  job.error = null;
  return job;
}

function advanceCompress(job) {
  if (job.state === "queued") {
    job.state = "running";
    job.progress = 0.55;
    return job;
  }
  const ratio = { LZX: 58, XPRESS16K: 68, XPRESS8K: 75, XPRESS4K: 84 }[job.algorithm] ?? 70;
  const before = 40_000_000_000;
  job.state = "completed";
  job.progress = 1;
  job.bytesBefore = before;
  job.bytesAfter = Math.round((before * ratio) / 100);
  job.outputMarker = `mock-compact:${job.folderPath}`;
  job.error = null;
  return job;
}

function advanceMove(job) {
  if (job.state === "queued") {
    job.state = "running";
    job.progress = 0.45;
    job.outputMarker = `mock-copy:${job.sourcePath}->${job.destinationPath}`;
    job.deleteSource = false;
    job.sourceDeleted = false;
    return job;
  }
  if (job.state === "running") {
    job.state = "verifying";
    job.progress = 0.8;
    job.deleteSource = false;
    return job;
  }
  job.state = "awaiting-confirm";
  job.progress = 1;
  job.verified = true;
  job.deleteSource = false;
  job.sourceDeleted = false;
  job.verify = {
    ok: true,
    sourceFiles: 128,
    destFiles: 128,
    sourceBytes: 52428800000,
    destBytes: 52428800000,
    sourceHash: "mockhash",
    destHash: "mockhash",
    message: "Совпали число файлов, объём и хеш списка файлов.",
  };
  job.error = null;
  return job;
}

export function confirmJob(job, deleteSource) {
  if (job.kind !== "move" || job.state !== "awaiting-confirm" || job.verified !== true) {
    throw httpError(400, "Источник не удаляется: копия ещё не проверена.");
  }
  job.state = "completed";
  job.spawned = false;
  if (deleteSource) {
    job.deleteSource = true;
    job.sourceDeleted = true;
  } else {
    job.deleteSource = false;
    job.sourceDeleted = false;
  }
  return job;
}
