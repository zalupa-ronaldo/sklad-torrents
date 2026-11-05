import { IndexError } from "@/addons/media-games/file-index/errors";

/**
 * NTFS uses file record 5 as the root directory of the volume.
 * Synthetic fixtures use the same parent index so paths can be rebuilt.
 */
export const NTFS_ROOT_RECORD = 5n;

/** Low 48 bits of an NTFS file reference are the MFT record number. The high 16 are the sequence. */
export const NTFS_RECORD_MASK = 0xffffffffffffn;

export interface MftFixtureEntry {
  recordNumber: bigint;
  parentRecord: bigint;
  size: number;
  inUse: boolean;
  isDirectory: boolean;
  name: string;
}

/**
 * Simplified MFT entry used as a fixture. This is not a dump of a live volume
 * and it is not parsed from the owner's disk. The layout keeps the fields a
 * path needs, with the same signature and flag bits as an on-disk FILE record:
 *
 *   0  char[4]   "FILE"
 *   4  uint32    record number (MFT index)
 *   8  uint64    parent file reference (low 48 bits are the parent index)
 *  16  uint64    file size in bytes
 *  24  uint16    flags: 0x0001 in use, 0x0002 directory
 *  26  uint16    file name length in UTF-16 code units
 *  28  utf16le   file name
 *
 * Entries are concatenated with no padding. Record 5 (name "." or empty, parent 5)
 * is the volume root and is not part of the displayed path.
 */
export function encodeMftEntry(entry: {
  recordNumber: number;
  parentRecord: number | bigint;
  size?: number | bigint;
  isDirectory?: boolean;
  inUse?: boolean;
  name: string;
}): Buffer {
  const nameBuf = Buffer.from(entry.name, "utf16le");
  const buf = Buffer.alloc(28 + nameBuf.length);
  buf.write("FILE", 0, "ascii");
  buf.writeUInt32LE(entry.recordNumber >>> 0, 4);
  buf.writeBigUInt64LE(BigInt(entry.parentRecord), 8);
  buf.writeBigUInt64LE(BigInt(entry.size ?? 0), 16);
  let flags = entry.inUse === false ? 0 : 0x0001;
  if (entry.isDirectory) flags |= 0x0002;
  buf.writeUInt16LE(flags, 24);
  buf.writeUInt16LE(nameBuf.length / 2, 26);
  nameBuf.copy(buf, 28);
  return buf;
}

export function encodeMftFixture(entries: Parameters<typeof encodeMftEntry>[0][]): Buffer {
  return Buffer.concat(entries.map((entry) => encodeMftEntry(entry)));
}

export function parseMftFixture(bytes: Uint8Array): MftFixtureEntry[] {
  const buf = Buffer.from(bytes);
  const entries: MftFixtureEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 28 > buf.length) {
      throw new IndexError("Синтетическая запись MFT обрезана.");
    }
    const signature = buf.toString("ascii", offset, offset + 4);
    if (signature !== "FILE") {
      throw new IndexError(`Синтетическая запись MFT: на смещении ${offset} нет сигнатуры FILE.`);
    }
    const recordNumber = BigInt(buf.readUInt32LE(offset + 4)) & NTFS_RECORD_MASK;
    const parentRecord = buf.readBigUInt64LE(offset + 8) & NTFS_RECORD_MASK;
    const size = buf.readBigUInt64LE(offset + 16);
    const flags = buf.readUInt16LE(offset + 24);
    const nameUnits = buf.readUInt16LE(offset + 26);
    const nameBytes = nameUnits * 2;
    if (offset + 28 + nameBytes > buf.length) {
      throw new IndexError("Имя в синтетической записи MFT выходит за пределы буфера.");
    }
    const name = buf.toString("utf16le", offset + 28, offset + 28 + nameBytes);
    entries.push({
      recordNumber,
      parentRecord,
      size: Number(size),
      inUse: (flags & 0x0001) !== 0,
      isDirectory: (flags & 0x0002) !== 0,
      name,
    });
    offset += 28 + nameBytes;
  }
  return entries;
}
