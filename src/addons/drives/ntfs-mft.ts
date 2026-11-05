import type { RawIndexedFile } from "@/addons/drives/types";

export interface NtfsGeometry {
  bytesPerSector: number;
  bytesPerCluster: number;
  mftLcn: number;
  recordSize: number;
}

export interface ParsedName {
  parent: number;
  name: string;
  namespace: number;
  size: number;
  mtimeMs: number;
  directory: boolean;
  index: number;
}

const FILE_NAME = 0x30;
const DATA = 0x80;
const END = 0xffffffff;

export function parseBootSector(boot: Buffer): NtfsGeometry | null {
  if (boot.length < 512) return null;
  if (boot.toString("latin1", 3, 7) !== "NTFS") return null;
  const bytesPerSector = boot.readUInt16LE(0x0b);
  const sectorsPerCluster = boot.readUInt8(0x0d);
  if (bytesPerSector < 512 || sectorsPerCluster === 0) return null;
  const bytesPerCluster = bytesPerSector * sectorsPerCluster;
  const mftLcn = Number(boot.readBigUInt64LE(0x30));
  const raw = boot.readInt8(0x40);
  const recordSize = raw > 0 ? raw * bytesPerCluster : 2 ** -raw;
  if (!Number.isFinite(mftLcn) || mftLcn < 0 || recordSize < 512 || recordSize > 4096) return null;
  return { bytesPerSector, bytesPerCluster, mftLcn, recordSize };
}

export function decodeRunlist(buf: Buffer): Array<{ lcn: number; length: number }> {
  let pos = 0;
  let lcn = 0;
  const runs: Array<{ lcn: number; length: number }> = [];
  while (pos < buf.length) {
    const header = buf[pos];
    if (header === 0) break;
    const lengthBytes = header & 0x0f;
    const offsetBytes = header >> 4;
    pos += 1;
    if (lengthBytes < 1 || pos + lengthBytes + offsetBytes > buf.length) break;
    let length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length += buf[pos + i] * 2 ** (8 * i);
    pos += lengthBytes;
    if (offsetBytes === 0) {
      runs.push({ lcn: -1, length });
    } else {
      let relative = 0;
      for (let i = 0; i < offsetBytes; i += 1) relative += buf[pos + i] * 2 ** (8 * i);
      const sign = 1 << (offsetBytes * 8 - 1);
      if (relative & sign) relative -= 2 ** (offsetBytes * 8);
      pos += offsetBytes;
      lcn += relative;
      runs.push({ lcn, length });
    }
  }
  return runs;
}

function applyFixup(record: Buffer, bytesPerSector: number): boolean {
  if (record.toString("latin1", 0, 4) !== "FILE") return false;
  const usaOffset = record.readUInt16LE(4);
  const usaCount = record.readUInt16LE(6);
  if (usaCount < 2 || usaOffset <= 0 || usaOffset + usaCount * 2 > record.length) return usaCount < 2;
  const usn = record.readUInt16LE(usaOffset);
  let cursor = usaOffset + 2;
  for (let sector = 1; sector < usaCount; sector += 1) {
    const end = sector * bytesPerSector - 2;
    if (end + 2 > record.length || record.readUInt16LE(end) !== usn) return false;
    record.writeUInt16LE(record.readUInt16LE(cursor), end);
    cursor += 2;
  }
  return true;
}

function filetimeToMs(buf: Buffer, offset: number): number {
  if (offset + 8 > buf.length) return 0;
  const ticks = Number(buf.readBigUInt64LE(offset));
  const ms = ticks / 10_000 - 11_644_473_600_000;
  return Number.isFinite(ms) ? ms : 0;
}

function fileRef(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset) + buf.readUInt16LE(offset + 4) * 0x1_0000_0000;
}

export function parseRecord(record: Buffer, index: number, bytesPerSector: number): ParsedName | null {
  if (!applyFixup(record, bytesPerSector)) return null;
  const flags = record.readUInt16LE(0x16);
  if ((flags & 0x01) === 0) return null;
  const directory = (flags & 0x02) !== 0;
  let offset = record.readUInt16LE(0x14);
  let best: ParsedName | null = null;
  while (offset + 8 <= record.length) {
    const type = record.readUInt32LE(offset);
    if (type === END || type === 0) break;
    const length = record.readUInt32LE(offset + 4);
    if (length < 16 || offset + length > record.length) break;
    const nonResident = record.readUInt8(offset + 8) === 1;
    if (type === FILE_NAME && !nonResident) {
      const valueLength = record.readUInt32LE(offset + 0x10);
      const valueOffset = record.readUInt16LE(offset + 0x14);
      if (valueOffset + valueLength <= length && valueLength >= 0x42) {
        const value = record.subarray(offset + valueOffset, offset + valueOffset + valueLength);
        const chars = value.readUInt8(0x40);
        const namespace = value.readUInt8(0x41);
        if (0x42 + chars * 2 <= value.length) {
          const parsed: ParsedName = {
            parent: fileRef(value, 0),
            name: value.toString("utf16le", 0x42, 0x42 + chars * 2),
            namespace,
            size: Number(value.readBigUInt64LE(0x30)),
            mtimeMs: filetimeToMs(value, 0x10),
            directory,
            index,
          };
          const rank = namespace === 1 || namespace === 3 ? 2 : namespace === 0 ? 1 : 0;
          const bestRank = best ? (best.namespace === 1 || best.namespace === 3 ? 2 : best.namespace === 0 ? 1 : 0) : -1;
          if (rank >= bestRank) best = parsed;
        }
      }
    }
    offset += length;
  }
  return best;
}

function takeMftRuns(record: Buffer, bytesPerSector: number): Buffer | null {
  if (!applyFixup(record, bytesPerSector)) return null;
  let offset = record.readUInt16LE(0x14);
  while (offset + 8 <= record.length) {
    const type = record.readUInt32LE(offset);
    if (type === END || type === 0) break;
    const length = record.readUInt32LE(offset + 4);
    if (length < 16 || offset + length > record.length) break;
    const nonResident = record.readUInt8(offset + 8) === 1;
    const nameLength = record.readUInt8(offset + 9);
    if (type === DATA && nameLength === 0 && nonResident) {
      const mapOffset = record.readUInt16LE(offset + 0x20);
      if (mapOffset >= 0x20 && mapOffset < length) return Buffer.from(record.subarray(offset + mapOffset, offset + length));
    }
    offset += length;
  }
  return null;
}

function resolvePath(entry: ParsedName, byIndex: ReadonlyMap<number, ParsedName>): string | null {
  const parts: string[] = [];
  let current: ParsedName | undefined = entry;
  const seen = new Set<number>();
  while (current) {
    if (current.index === 5) break;
    if (seen.has(current.index)) return null;
    seen.add(current.index);
    if (!current.name || current.name === "." || current.name === ".." || current.name.startsWith("$")) return null;
    parts.push(current.name);
    if (current.parent === 5) break;
    const parent = byIndex.get(current.parent);
    if (!parent) return null;
    current = parent;
  }
  if (parts.length === 0) return null;
  parts.reverse();
  return parts.join("/");
}

export function filesFromRecords(records: Buffer[], recordSize: number, bytesPerSector: number): RawIndexedFile[] {
  const entries: ParsedName[] = [];
  records.forEach((record, index) => {
    const slice = record.length === recordSize ? record : record.subarray(0, recordSize);
    const parsed = parseRecord(Buffer.from(slice), index, bytesPerSector);
    if (parsed) entries.push(parsed);
  });
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const files: RawIndexedFile[] = [];
  for (const entry of entries) {
    const relativePath = resolvePath(entry, byIndex);
    if (!relativePath) continue;
    files.push({
      relativePath,
      name: entry.name,
      kind: entry.directory ? "dir" : "file",
      size: entry.directory ? 0 : entry.size,
      mtimeMs: entry.mtimeMs,
    });
  }
  return files;
}

async function readBlock(
  readAt: (offset: number, length: number) => Promise<Buffer>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.from(await readAt(offset, length));
  if (buf.length !== length) throw new Error("Короткое чтение тома.");
  return buf;
}

function consume(
  chunk: Buffer,
  startIndex: number,
  geometry: NtfsGeometry,
  entries: ParsedName[],
  maxRecords: number,
  stopOnZero: boolean,
): { read: number; complete: boolean; stopped: boolean } {
  let read = 0;
  for (let offset = 0; offset + geometry.recordSize <= chunk.length; offset += geometry.recordSize) {
    const index = startIndex + read;
    if (index >= maxRecords) return { read, complete: false, stopped: true };
    const record = chunk.subarray(offset, offset + geometry.recordSize);
    if (record.subarray(0, 4).every((byte) => byte === 0)) {
      if (stopOnZero) return { read, complete: true, stopped: true };
    } else {
      const parsed = parseRecord(Buffer.from(record), index, geometry.bytesPerSector);
      if (parsed) entries.push(parsed);
    }
    read += 1;
  }
  return { read, complete: true, stopped: false };
}

export async function readNtfsVolume(
  readAt: (offset: number, length: number) => Promise<Buffer>,
  options?: { maxRecords?: number },
): Promise<{ files: RawIndexedFile[]; complete: boolean }> {
  const maxRecords = options?.maxRecords ?? 200_000;
  const boot = await readBlock(readAt, 0, 512);
  const geometry = parseBootSector(boot);
  if (!geometry) return { files: [], complete: false };
  const entries: ParsedName[] = [];
  let complete = true;
  const firstOffset = geometry.mftLcn * geometry.bytesPerCluster;
  const first = await readBlock(readAt, firstOffset, geometry.recordSize);
  const runs = takeMftRuns(Buffer.from(first), geometry.bytesPerSector);
  if (runs && runs.length > 0) {
    let index = 0;
    for (const run of decodeRunlist(runs)) {
      if (run.lcn < 0) {
        index += Math.floor((run.length * geometry.bytesPerCluster) / geometry.recordSize);
        continue;
      }
      const length = run.length * geometry.bytesPerCluster;
      const data = await readBlock(readAt, run.lcn * geometry.bytesPerCluster, length);
      const consumed = consume(data, index, geometry, entries, maxRecords, false);
      index += consumed.read;
      if (!consumed.complete) {
        complete = false;
        break;
      }
    }
  } else {
    let offset = firstOffset;
    let index = 0;
    for (;;) {
      if (index >= maxRecords) {
        complete = false;
        break;
      }
      const chunk = await readBlock(readAt, offset, geometry.recordSize * 32);
      const consumed = consume(chunk, index, geometry, entries, maxRecords, true);
      index += consumed.read;
      if (!consumed.complete) {
        complete = false;
        break;
      }
      if (consumed.stopped) break;
      offset += chunk.length;
    }
  }
  return { files: filesFromRecordsFromEntries(entries), complete };
}

function filesFromRecordsFromEntries(entries: ParsedName[]): RawIndexedFile[] {
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const files: RawIndexedFile[] = [];
  for (const entry of entries) {
    const relativePath = resolvePath(entry, byIndex);
    if (!relativePath) continue;
    files.push({
      relativePath,
      name: entry.name,
      kind: entry.directory ? "dir" : "file",
      size: entry.directory ? 0 : entry.size,
      mtimeMs: entry.mtimeMs,
    });
  }
  return files;
}
