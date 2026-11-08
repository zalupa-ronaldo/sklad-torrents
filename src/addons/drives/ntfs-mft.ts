import { resolveOnDisk } from "@/addons/drives/ondisk";
import type { RawIndexedFile } from "@/addons/drives/types";

export interface NtfsGeometry {
  bytesPerSector: number;
  bytesPerCluster: number;
  mftLcn: number;
  recordSize: number;
}

export interface FileLink {
  parent: number;
  parentSequence: number;
  name: string;
  namespace: number;
  size: number;
  mtimeMs: number;
}

export interface ParsedName {
  parent: number;
  name: string;
  namespace: number;
  /** Logical size from $FILE_NAME. Windows often leaves this at 0; $DATA is authoritative. */
  size: number;
  mtimeMs: number;
  directory: boolean;
  index: number;
  /** Base MFT record. Equals `index` when this record is the base. */
  base: number;
  hasName: boolean;
  /** Record sequence number at offset 0x10. */
  sequence: number;
  /** Every $FILE_NAME in the record. The ranked name stays in `name` for older callers. */
  links: FileLink[];
  /** Unnamed $DATA real size, or null when the record has no unnamed data attribute. */
  dataSize: number | null;
  dataAllocated: number | null;
  /** Real size of WofCompressedData. Null when that named stream was not in the record. */
  wofBytes: number | null;
  wofTag: boolean;
  ntfsCompressed: boolean;
}

const FILE_NAME = 0x30;
const DATA = 0x80;
const REPARSE = 0xc0;
const END = 0xffffffff;
const WOF_TAG = 0x80000017;
const WOF_STREAM = "WofCompressedData";
const NTFS_COMPRESSED = 0x0001;

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

function u64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function attributeName(record: Buffer, offset: number, length: number): string {
  if (offset + 0x0c > record.length) return "";
  const chars = record.readUInt8(offset + 9);
  if (chars === 0) return "";
  const nameOffset = record.readUInt16LE(offset + 0x0a);
  const start = offset + nameOffset;
  const bytes = chars * 2;
  if (nameOffset <= 0 || start + bytes > offset + length || start + bytes > record.length) return "";
  return record.toString("utf16le", start, start + bytes);
}

/** $DATA size fields. `name` is empty for the main stream and WofCompressedData for CompactGUI. */
function readDataStream(record: Buffer, offset: number, length: number, nonResident: boolean): { name: string; size: number; allocated: number; compressed: boolean } | null {
  if (offset + 0x10 > record.length) return null;
  const name = attributeName(record, offset, length);
  const compressed = offset + 0x0e <= record.length && (record.readUInt16LE(offset + 0x0c) & NTFS_COMPRESSED) !== 0;
  if (!nonResident) {
    if (length < 0x18 || offset + 0x14 > record.length) return null;
    const valueLength = record.readUInt32LE(offset + 0x10);
    if (valueLength > length) return null;
    return { name, size: valueLength, allocated: valueLength, compressed };
  }
  if (length < 0x40 || offset + 0x38 > record.length) return null;
  return { name, size: u64(record, offset + 0x30), allocated: u64(record, offset + 0x28), compressed };
}

function readReparseTag(record: Buffer, offset: number, length: number, nonResident: boolean): number | null {
  if (nonResident || length < 0x18 || offset + 0x1c > record.length) return null;
  const valueLength = record.readUInt32LE(offset + 0x10);
  const valueOffset = record.readUInt16LE(offset + 0x14);
  if (valueLength < 4 || offset + valueOffset + 4 > record.length) return null;
  return record.readUInt32LE(offset + valueOffset);
}

export function parseRecord(record: Buffer, index: number, bytesPerSector: number): ParsedName | null {
  if (record.length < 0x28 || !applyFixup(record, bytesPerSector)) return null;
  const flags = record.readUInt16LE(0x16);
  if ((flags & 0x01) === 0) return null;
  const directory = (flags & 0x02) !== 0;
  const baseWord = record.readBigUInt64LE(0x20);
  const baseRef = Number(baseWord & 0xffffffffffffn);
  let offset = record.readUInt16LE(0x14);
  const sequence = record.readUInt16LE(0x10);
  const links: FileLink[] = [];
  let best: { parent: number; parentSequence: number; name: string; namespace: number; size: number; mtimeMs: number; rank: number } | null = null;
  let dataSize: number | null = null;
  let dataAllocated: number | null = null;
  let wofBytes: number | null = null;
  let wofTag = false;
  let ntfsCompressed = false;
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
          const rank = namespace === 1 || namespace === 3 ? 2 : namespace === 0 ? 1 : 0;
          const parentWord = value.readBigUInt64LE(0);
          const link: FileLink = {
            parent: Number(parentWord & 0xffffffffffffn),
            parentSequence: Number((parentWord >> 48n) & 0xffffn),
            name: value.toString("utf16le", 0x42, 0x42 + chars * 2),
            namespace,
            size: u64(value, 0x30),
            mtimeMs: filetimeToMs(value, 0x10),
          };
          links.push(link);
          if (!best || rank >= best.rank) best = { ...link, rank };
        }
      }
    } else if (type === DATA) {
      const data = readDataStream(record, offset, length, nonResident);
      if (data && data.name === WOF_STREAM && (wofBytes == null || data.size > wofBytes)) {
        // CompactGUI stores the compressed payload here. Its length is the occupied WOF size.
        wofBytes = data.size;
      } else if (data && data.name === "") {
        if (data.compressed) ntfsCompressed = true;
        if (dataSize == null || data.size > dataSize) {
          dataSize = data.size;
          dataAllocated = data.allocated;
        }
      }
    } else if (type === REPARSE) {
      const tag = readReparseTag(record, offset, length, nonResident);
      if (tag === WOF_TAG) wofTag = true;
    }
    offset += length;
  }
  if (!best && dataSize == null && wofBytes == null && !wofTag) return null;
  return {
    parent: best?.parent ?? 0,
    name: best?.name ?? "",
    namespace: best?.namespace ?? 0,
    size: best?.size ?? 0,
    mtimeMs: best?.mtimeMs ?? 0,
    directory,
    index,
    base: baseWord === 0n ? index : baseRef,
    hasName: best != null,
    sequence,
    links,
    dataSize,
    dataAllocated,
    wofBytes,
    wofTag,
    ntfsCompressed,
  };
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

function preferData(target: ParsedName, extra: ParsedName): void {
  if (extra.dataSize != null && (target.dataSize == null || extra.dataSize > target.dataSize)) {
    target.dataSize = extra.dataSize;
    target.dataAllocated = extra.dataAllocated;
  }
  if (extra.wofBytes != null && (target.wofBytes == null || extra.wofBytes > target.wofBytes)) target.wofBytes = extra.wofBytes;
  target.wofTag = target.wofTag || extra.wofTag;
  target.ntfsCompressed = target.ntfsCompressed || extra.ntfsCompressed;
  if (target.links.length === 0 && extra.links.length > 0) target.links = extra.links;
  if (!target.hasName && extra.hasName) {
    target.hasName = true;
    target.name = extra.name;
    target.parent = extra.parent;
    target.namespace = extra.namespace;
    target.size = extra.size;
    target.mtimeMs = extra.mtimeMs;
    target.directory = target.directory || extra.directory;
  }
}

/**
 * Extension records (base file reference ≠ 0) hold $DATA that did not fit in the base.
 * Their size is attached to the base so a fragmented file is not reported as 0 bytes.
 */
export function filesFromParsed(entries: readonly ParsedName[]): RawIndexedFile[] {
  const bases = new Map<number, ParsedName>();
  const extras: ParsedName[] = [];
  for (const entry of entries) {
    if (entry.base !== entry.index) extras.push(entry);
    else bases.set(entry.index, entry);
  }
  for (const extra of extras) {
    const base = bases.get(extra.base);
    if (base) preferData(base, extra);
  }
  const files: RawIndexedFile[] = [];
  for (const entry of bases.values()) {
    if (!entry.hasName) continue;
    const relativePath = resolvePath(entry, bases);
    if (!relativePath) continue;
    // No unnamed $DATA and a zero $FILE_NAME length is unknown. A real empty file has $DATA of length 0.
    const size: number | null = entry.directory ? 0 : entry.dataSize != null ? entry.dataSize : entry.size > 0 ? entry.size : null;
    const measured = entry.directory
      ? null
      : resolveOnDisk({
          size: size ?? 0,
          allocated: entry.dataAllocated,
          wofBytes: entry.wofBytes,
          wofUnmeasured: entry.wofTag && entry.wofBytes == null,
          ntfsCompressed: entry.ntfsCompressed,
        });
    const file: RawIndexedFile = {
      relativePath,
      name: entry.name,
      kind: entry.directory ? "dir" : "file",
      size,
      mtimeMs: entry.mtimeMs,
    };
    if (!entry.directory && entry.dataAllocated != null) file.allocated = entry.dataAllocated;
    if (measured?.onDisk != null) file.onDisk = measured.onDisk;
    if (measured?.compression) file.compression = measured.compression;
    files.push(file);
  }
  return files;
}

export interface MftCatalog {
  files: RawIndexedFile[];
  userFiles: number;
  userDirs: number;
  nonempty: number;
  explicitZero: number;
  unknownSize: number;
  logicalBytes: number;
  allocatedBytes: number;
  unknownAllocated: number;
  hardlinks: number;
  unresolved: number;
  cycles: number;
  sequenceMismatch: number;
  unsafe: number;
  meta: number;
  wof: number;
}

function nameClass(name: string): "ok" | "meta" | "unsafe" {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":")) return "unsafe";
  if (name.startsWith("$")) return "meta";
  return "ok";
}

function resolveLink(entry: ParsedName, link: FileLink, byIndex: ReadonlyMap<number, ParsedName>): { path: string | null; cycle: boolean; sequence: boolean; unsafe: boolean; meta: boolean } {
  const own = nameClass(link.name);
  if (own !== "ok") return { path: null, cycle: false, sequence: false, unsafe: own === "unsafe", meta: own === "meta" };
  const parent = byIndex.get(link.parent);
  if (link.parent !== 5 && link.parentSequence !== 0 && parent && parent.sequence !== link.parentSequence) {
    return { path: null, cycle: false, sequence: true, unsafe: false, meta: false };
  }
  const parts = [link.name];
  let current = link.parent === 5 ? undefined : parent;
  const seen = new Set<number>([entry.index]);
  while (current) {
    if (current.index === 5) break;
    if (seen.has(current.index)) return { path: null, cycle: true, sequence: false, unsafe: false, meta: false };
    seen.add(current.index);
    const step = current.links[0] ?? { parent: current.parent, parentSequence: 0, name: current.name, namespace: current.namespace, size: current.size, mtimeMs: current.mtimeMs };
    const stepClass = nameClass(step.name);
    if (stepClass !== "ok") return { path: null, cycle: false, sequence: false, unsafe: stepClass === "unsafe", meta: stepClass === "meta" };
    parts.push(step.name);
    if (step.parent === 5) break;
    const next = byIndex.get(step.parent);
    if (step.parentSequence !== 0 && next && next.sequence !== step.parentSequence) {
      return { path: null, cycle: false, sequence: true, unsafe: false, meta: false };
    }
    if (!next) return { path: null, cycle: false, sequence: false, unsafe: false, meta: false };
    current = next;
  }
  parts.reverse();
  return { path: parts.join("/"), cycle: false, sequence: false, unsafe: false, meta: false };
}

/** One catalog row per hardlink path. Logical bytes are counted once per MFT record. */
export function catalogFromParsed(entries: readonly ParsedName[]): MftCatalog {
  const bases = new Map<number, ParsedName>();
  const extras: ParsedName[] = [];
  for (const entry of entries) {
    if (entry.base !== entry.index) extras.push(entry);
    else bases.set(entry.index, entry);
  }
  for (const extra of extras) {
    const base = bases.get(extra.base);
    if (base) preferData(base, extra);
  }
  const stats: MftCatalog = {
    files: [],
    userFiles: 0,
    userDirs: 0,
    nonempty: 0,
    explicitZero: 0,
    unknownSize: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    unknownAllocated: 0,
    hardlinks: 0,
    unresolved: 0,
    cycles: 0,
    sequenceMismatch: 0,
    unsafe: 0,
    meta: 0,
    wof: 0,
  };
  for (const entry of bases.values()) {
    const links = entry.links.length > 0 ? entry.links : entry.hasName ? [{
      parent: entry.parent,
      parentSequence: 0,
      name: entry.name,
      namespace: entry.namespace,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    }] : [];
    let counted = false;
    links.forEach((link, linkIndex) => {
      const resolved = resolveLink(entry, link, bases);
      if (resolved.cycle) stats.cycles += 1;
      if (resolved.sequence) stats.sequenceMismatch += 1;
      if (resolved.unsafe) stats.unsafe += 1;
      if (resolved.meta) stats.meta += 1;
      if (!resolved.path) {
        if (!resolved.cycle && !resolved.sequence && !resolved.unsafe && !resolved.meta) stats.unresolved += 1;
        return;
      }
      const primary = linkIndex === 0;
      const size: number | null = entry.directory ? 0 : entry.dataSize != null ? entry.dataSize : link.size > 0 ? link.size : null;
      const file: RawIndexedFile = {
        relativePath: resolved.path,
        name: link.name,
        kind: entry.directory ? "dir" : "file",
        size: primary ? size : size,
        mtimeMs: link.mtimeMs,
      };
      if (!entry.directory && primary && entry.dataAllocated != null) file.allocated = entry.dataAllocated;
      if (!entry.directory && primary && entry.wofBytes != null) {
        file.onDisk = entry.wofBytes;
        file.compression = "wof";
        stats.wof += 1;
      }
      stats.files.push(file);
      if (!primary) stats.hardlinks += 1;
      if (!counted && !entry.directory) {
        counted = true;
        stats.userFiles += 1;
        if (size == null) stats.unknownSize += 1;
        else if (size === 0) stats.explicitZero += 1;
        else {
          stats.nonempty += 1;
          stats.logicalBytes += size;
        }
        if (entry.dataAllocated == null) stats.unknownAllocated += 1;
        else stats.allocatedBytes += entry.dataAllocated;
      }
      if (!counted && entry.directory) {
        counted = true;
        stats.userDirs += 1;
      }
    });
  }
  return stats;
}

export function filesFromRecords(records: Buffer[], recordSize: number, bytesPerSector: number): RawIndexedFile[] {
  const entries: ParsedName[] = [];
  records.forEach((record, index) => {
    const slice = record.length === recordSize ? record : record.subarray(0, recordSize);
    const parsed = parseRecord(Buffer.from(slice), index, bytesPerSector);
    if (parsed) entries.push(parsed);
  });
  return filesFromParsed(entries);
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
  const maxRecords = options?.maxRecords ?? 5_000_000;
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
  return filesFromParsed(entries);
}
