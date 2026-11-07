import { Worker } from "node:worker_threads";
import path from "node:path";

import {
  adoptCatalogDisks,
  catalogFilePath,
  HEAVY_CATALOG_BYTES,
  persistLargeCatalogUnlocked,
  premigratePath,
  preserveCatalogOriginal,
  withCatalogWrite,
} from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { dataDir } from "@/lib/qbittorrent/store";

let started = false;
let finished: Promise<void> = Promise.resolve();

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const parsed = JSON.parse(fs.readFileSync(workerData.catalog, "utf8"));
const dir = workerData.filesDir;
fs.mkdirSync(dir, { recursive: true });
const counts = () => ({ torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 });
const disks = [];
for (const disk of parsed.disks || []) {
  const files = Array.isArray(disk.files) ? disk.files : [];
  let fileStore = disk.fileStore;
  if (files.length > 20000) {
    const finalPath = path.join(dir, disk.id + ".ndjson");
    const tmp = finalPath + "." + process.pid + "." + Date.now().toString(36) + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      for (const file of files) fs.writeSync(fd, JSON.stringify(file) + "\\n");
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, finalPath);
    fileStore = finalPath;
  }
  let indexedBytes = 0;
  let fileCount = 0;
  let unknownSizes = 0;
  const categoryCounts = counts();
  for (const file of files) {
    if (!file || file.kind !== "file" || file.name === "sklad-catalog.json") continue;
    fileCount += 1;
    if (typeof file.size !== "number") unknownSizes += 1;
    else if (file.size > 0) indexedBytes += file.size;
    for (const category of file.categories || []) if (categoryCounts[category] !== undefined) categoryCounts[category] += 1;
  }
  const computed = { fileCount, indexedBytes, categoryCounts, ...(unknownSizes ? { unknownSizes } : {}) };
  const summary = files.length > 0 ? computed : (disk.summary && disk.summary.fileCount > 0 ? disk.summary : undefined);
  const next = { ...disk, files: fileStore && files.length > 20000 ? [] : files, fileStore, summary };
  if (!summary) delete next.summary;
  disks.push(next);
}
parentPort.postMessage({ disks });
`;

/** Parse a giant v1 catalog off the request thread. The original file is copied aside and is not replaced by the worker. */
export function startLegacyCatalogMigrate(): void {
  if (started) return;
  started = true;
  let resolveDone: () => void = () => undefined;
  finished = new Promise((resolve) => {
    resolveDone = resolve;
  });
  void begin(resolveDone);
}

async function begin(resolveDone: () => void): Promise<void> {
  try {
    const source = await preserveCatalogOriginal();
    if (!source) {
      started = false;
      resolveDone();
      return;
    }
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { catalog: source, filesDir: path.join(dataDir(), "drive-files") },
    });
    worker.once("message", (message: { disks?: DiskRecord[] }) => {
      void withCatalogWrite(async () => {
        if (Array.isArray(message?.disks)) {
          const merged = adoptCatalogDisks(message.disks);
          await persistLargeCatalogUnlocked(merged);
        }
      })
        .catch(() => undefined)
        .finally(resolveDone);
    });
    worker.once("error", () => {
      started = false;
      resolveDone();
    });
  } catch {
    started = false;
    resolveDone();
  }
}

export function legacyMigrateStarted(): boolean {
  return started;
}

export function legacyMigrateFinished(): Promise<void> {
  return finished;
}

export function resetLegacyMigrateForTests(): void {
  started = false;
  finished = Promise.resolve();
}

export { HEAVY_CATALOG_BYTES, catalogFilePath, premigratePath };
