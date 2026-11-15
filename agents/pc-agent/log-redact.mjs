import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

const SECRET = /(?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;
const BEARER = /Bearer\s+\S+/gi;
const Z_WIN = /\bZ:\\[^\s"]*/gi;
const Z_MNT = /\/mnt\/z(?:\/[^\s"]*)?/gi;

export function redactLine(line) {
  return String(line)
    .replace(SECRET, "[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(Z_WIN, "[redacted]")
    .replace(Z_MNT, "[redacted]");
}

export function readLogTail(file, tail = 200) {
  if (!file || !existsSync(file)) return [];
  const limit = Math.max(1, Math.min(Number(tail) || 200, 500));
  const handle = openSync(file, "r");
  try {
    const size = fstatSync(handle).size;
    const take = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(take);
    readSync(handle, buffer, 0, take, size - take);
    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-limit)
      .map(redactLine);
  } finally {
    closeSync(handle);
  }
}
