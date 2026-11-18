import { readFile } from "node:fs/promises";

/**
 * Read-only AV1 progress. These paths are logs the PC already writes.
 * This module never starts HandBrake, PowerShell, or a queue.
 */
export const AV1_LANES = [
  {
    id: "suits",
    label: "Suits AV1",
    dir: "S:\\сирики\\Suits_AV1\\_logs",
    status: "status.json",
    log: "queue.log",
  },
  {
    id: "library",
    label: "Библиотека AV1",
    dir: "S:\\_AV1\\_logs",
    status: "status.json",
    log: "library-queue.log",
    csv: "library-queue.csv",
  },
];

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseStatusJson(text) {
  if (typeof text !== "string" || !text.trim()) return { fields: {}, errors: [] };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { fields: {}, errors: ["status.json не JSON."] };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields: {}, errors: ["status.json не объект."] };
  const percent = numberOrNull(body.percent);
  const progress = numberOrNull(body.progress);
  const fields = {
    currentFile: textOrNull(body.currentFile) || textOrNull(body.file) || textOrNull(body.current),
    percent: percent !== null ? percent : progress !== null && progress <= 1 ? progress * 100 : progress,
    fps: numberOrNull(body.fps),
    etaSec: numberOrNull(body.etaSec) ?? numberOrNull(body.eta),
    done: numberOrNull(body.done),
    total: numberOrNull(body.total),
    spaceFreedBytes: numberOrNull(body.spaceFreedBytes) ?? numberOrNull(body.freedBytes),
  };
  const errors = [];
  if (typeof body.error === "string" && body.error.trim()) errors.push(body.error.trim());
  if (Array.isArray(body.errors)) {
    for (const item of body.errors) {
      if (typeof item === "string" && item.trim()) errors.push(item.trim());
    }
  }
  return { fields, errors };
}

export function parseQueueLog(text) {
  const fields = {};
  const errors = [];
  if (typeof text !== "string" || !text.trim()) return { fields, errors };
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/error|ошибка|fail/i.test(line)) errors.push(line);
    const percent = line.match(/(\d+(?:\.\d+)?)\s*%/);
    const fps = line.match(/fps[:\s]+(\d+(?:\.\d+)?)/i);
    const eta = line.match(/eta[:\s]+(\d+)/i);
    if (percent) fields.percent = Number(percent[1]);
    if (fps) fields.fps = Number(fps[1]);
    if (eta) fields.etaSec = Number(eta[1]);
  }
  return { fields, errors };
}

export function parseLibraryCsv(text) {
  const fields = {};
  const errors = [];
  if (typeof text !== "string" || !text.trim()) return { fields, errors };
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { fields, errors };
  const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
  const statusIndex = header.findIndex((cell) => cell === "status" || cell === "state");
  const freedIndex = header.findIndex((cell) => cell === "freed" || cell === "freedbytes" || cell === "spacefreedbytes");
  const fileIndex = header.findIndex((cell) => cell === "file" || cell === "currentfile" || cell === "name");
  if (statusIndex < 0 && freedIndex < 0 && fileIndex < 0) return { fields, errors };
  const rows = lines.slice(1).map((line) => line.split(",").map((cell) => cell.trim()));
  fields.total = rows.length;
  if (statusIndex >= 0) {
    const done = rows.filter((row) => /^(done|complete|completed|готово)$/i.test(row[statusIndex] || "")).length;
    fields.done = done;
    const current = rows.find((row) => /^(run|running|encoding|идёт)$/i.test(row[statusIndex] || ""));
    if (current && fileIndex >= 0 && current[fileIndex]) fields.currentFile = current[fileIndex];
  }
  if (freedIndex >= 0) {
    const sum = rows.reduce((total, row) => total + (numberOrNull(row[freedIndex]) ?? 0), 0);
    if (rows.some((row) => numberOrNull(row[freedIndex]) !== null)) fields.spaceFreedBytes = sum;
  }
  return { fields, errors };
}

function merge(base, extra) {
  const next = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (next[key] == null && value != null) next[key] = value;
  }
  return next;
}

export function combineLane(parts) {
  let fields = {};
  const errors = [];
  for (const part of parts) {
    fields = merge(fields, part.fields || {});
    for (const error of part.errors || []) errors.push(error);
  }
  return {
    currentFile: fields.currentFile ?? null,
    percent: fields.percent ?? null,
    fps: fields.fps ?? null,
    etaSec: fields.etaSec ?? null,
    done: fields.done ?? null,
    total: fields.total ?? null,
    spaceFreedBytes: fields.spaceFreedBytes ?? null,
    errors,
  };
}

async function readOptional(read, file, missing) {
  try {
    return { text: await read(file), missing: null };
  } catch (error) {
    const code = error && error.code;
    if (code === "ENOENT") return { text: "", missing };
    return { text: "", missing: error instanceof Error ? error.message : missing };
  }
}

export async function readAv1Status(options = {}) {
  const read = options.readFile || ((file) => readFile(file, "utf8"));
  const lanes = [];
  for (const lane of AV1_LANES) {
    const statusPath = `${lane.dir}\\${lane.status}`;
    const logPath = `${lane.dir}\\${lane.log}`;
    const csvPath = lane.csv ? `${lane.dir}\\${lane.csv}` : null;
    const status = await readOptional(read, statusPath, `${lane.status} нет`);
    const log = await readOptional(read, logPath, `${lane.log} нет`);
    const csv = csvPath ? await readOptional(read, csvPath, `${lane.csv} нет`) : { text: "", missing: null };
    const combined = combineLane([
      parseStatusJson(status.text),
      parseQueueLog(log.text),
      parseLibraryCsv(csv.text),
    ]);
    const missing = [status.missing, log.missing, csv.missing].filter(Boolean);
    lanes.push({
      id: lane.id,
      label: lane.label,
      dir: lane.dir,
      ...combined,
      errors: [...combined.errors, ...missing],
    });
  }
  return { online: true, started: false, lanes };
}
