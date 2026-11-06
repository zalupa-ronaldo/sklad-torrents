import { Worker } from "node:worker_threads";
import path from "node:path";

import { catalogFilePath, HEAVY_CATALOG_BYTES, setLiveDisks } from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { dataDir } from "@/lib/qbittorrent/store";

let started = false;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const parsed = JSON.parse(fs.readFileSync(workerData.catalog, "utf8"));
const dir = workerData.filesDir;
fs.mkdirSync(dir, { recursive: true });
const counts = () => ({ torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 });
const disks = [];
for (const disk of parsed.disks || []) {
  const files = Array.isArray(disk.files) ? disk.files : [];
  let fileStore = disk.fileStore;
  if (files.length > 20000) {
    fileStore = path.join(dir, disk.id + ".ndjson");
    const fd = fs.openSync(fileStore, "w");
    for (const file of files) fs.writeSync(fd, JSON.stringify(file) + "\\n");
    fs.closeSync(fd);
  }
  const categoryCounts = counts();
  let indexedBytes = 0;
  let fileCount = 0;
  for (const file of files) {
    if (!file || file.kind !== "file" || file.name === "sklad-catalog.json") continue;
    fileCount += 1;
    if (file.size > 0) indexedBytes += file.size;
    for (const category of file.categories || []) if (categoryCounts[category] !== undefined) categoryCounts[category] += 1;
  }
  disks.push({ ...disk, files: fileStore && files.length > 20000 ? [] : files, fileStore, summary: disk.summary || { fileCount, indexedBytes, categoryCounts } });
}
const next = { version: 2, seeded: parsed.seeded !== false, disks };
const tmp = workerData.catalog + ".v2tmp";
fs.writeFileSync(tmp, JSON.stringify(next));
fs.renameSync(tmp, workerData.catalog);
parentPort.postMessage({ disks });
`;

/** Parse a giant v1 catalog off the request thread and split out file lists. */
export function startLegacyCatalogMigrate(): void {
  if (started) return;
  started = true;
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { catalog: catalogFilePath(), filesDir: path.join(dataDir(), "drive-files") },
  });
  worker.once("message", (message: { disks?: DiskRecord[] }) => {
    if (Array.isArray(message?.disks)) setLiveDisks(message.disks);
  });
  worker.once("error", () => {
    started = false;
  });
}

export function legacyMigrateStarted(): boolean {
  return started;
}

export { HEAVY_CATALOG_BYTES };
