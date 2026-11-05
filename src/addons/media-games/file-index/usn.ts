import { IndexError } from "@/addons/media-games/file-index/errors";
import { NTFS_RECORD_MASK } from "@/addons/media-games/file-index/mft";

/**
 * Reason codes from winioctl.h. A journal record often also sets CLOSE (0x80000000)
 * on the same record as create, rename, or delete.
 */
export const UsnReason = {
  DATA_OVERWRITE: 0x00000001,
  DATA_EXTEND: 0x00000002,
  DATA_TRUNCATION: 0x00000004,
  FILE_CREATE: 0x00000100,
  FILE_DELETE: 0x00000200,
  RENAME_OLD_NAME: 0x00001000,
  RENAME_NEW_NAME: 0x00002000,
  CLOSE: 0x80000000,
} as const;

/** FILE_ATTRIBUTE_DIRECTORY */
export const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

export type UsnAction = "delete" | "rename-new" | "create" | "rename-old" | "ignore";

export interface ParsedUsnRecord {
  fileRef: bigint;
  parentRef: bigint;
  usn: bigint;
  reason: number;
  attributes: number;
  name: string;
}

/**
 * USN_RECORD_V2 (winioctl.h), little-endian. Synthetic tests and a real
 * FSCTL_READ_USN_JOURNAL / FSCTL_ENUM_USN_DATA buffer share this decoder.
 *
 *   0  uint32  RecordLength
 *   4  uint16  MajorVersion (2)
 *   6  uint16  MinorVersion
 *   8  uint64  FileReferenceNumber
 *  16  uint64  ParentFileReferenceNumber
 *  24  int64   Usn
 *  32  int64   TimeStamp
 *  40  uint32  Reason
 *  44  uint32  SourceInfo
 *  48  uint32  SecurityId
 *  52  uint32  FileAttributes
 *  56  uint16  FileNameLength (bytes)
 *  58  uint16  FileNameOffset
 *  .. utf16le FileName
 *
 * RecordLength is 8-byte aligned. Version 3 records are skipped by RecordLength
 * so a mixed buffer does not desynchronise; v1 of this indexer applies V2 only.
 * The Windows agent strips the 8-byte FRN/USN header before calling this parser.
 */
export function encodeUsnRecord(input: {
  fileRef: bigint;
  parentRef: bigint;
  usn?: bigint;
  reason: number;
  name: string;
  isDirectory?: boolean;
  attributes?: number;
}): Buffer {
  const nameBuf = Buffer.from(input.name, "utf16le");
  const nameOffset = 60;
  const rawLength = nameOffset + nameBuf.length;
  const recordLength = rawLength + ((8 - (rawLength % 8)) % 8);
  const buf = Buffer.alloc(recordLength);
  buf.writeUInt32LE(recordLength, 0);
  buf.writeUInt16LE(2, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeBigUInt64LE(input.fileRef, 8);
  buf.writeBigUInt64LE(input.parentRef, 16);
  buf.writeBigInt64LE(input.usn ?? 1n, 24);
  buf.writeUInt32LE(input.reason >>> 0, 40);
  let attributes = input.attributes ?? 0x20; // FILE_ATTRIBUTE_ARCHIVE
  if (input.isDirectory) attributes |= FILE_ATTRIBUTE_DIRECTORY;
  buf.writeUInt32LE(attributes >>> 0, 52);
  buf.writeUInt16LE(nameBuf.length, 56);
  buf.writeUInt16LE(nameOffset, 58);
  nameBuf.copy(buf, nameOffset);
  return buf;
}

export function encodeUsnJournal(records: Buffer[]): Buffer {
  return Buffer.concat(records);
}

export function parseUsnRecords(bytes: Uint8Array): ParsedUsnRecord[] {
  const buf = Buffer.from(bytes);
  const records: ParsedUsnRecord[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const recordLength = buf.readUInt32LE(offset);
    if (recordLength === 0) break;
    if (recordLength < 60 || offset + recordLength > buf.length) {
      throw new IndexError("Запись USN обрезана или короче заголовка V2.");
    }
    const major = buf.readUInt16LE(offset + 4);
    if (major === 2) {
      const nameLength = buf.readUInt16LE(offset + 56);
      const nameOffset = buf.readUInt16LE(offset + 58);
      if (nameOffset < 60 || nameOffset + nameLength > recordLength) {
        throw new IndexError("Имя в записи USN выходит за пределы записи.");
      }
      records.push({
        fileRef: buf.readBigUInt64LE(offset + 8) & NTFS_RECORD_MASK,
        parentRef: buf.readBigUInt64LE(offset + 16) & NTFS_RECORD_MASK,
        usn: buf.readBigInt64LE(offset + 24),
        reason: buf.readUInt32LE(offset + 40),
        attributes: buf.readUInt32LE(offset + 52),
        name: buf.toString("utf16le", offset + nameOffset, offset + nameOffset + nameLength),
      });
    }
    offset += recordLength;
  }
  return records;
}

/** CLOSE is ignored as a structural change; it usually rides along with create/rename/delete. */
export function classifyUsn(reason: number): UsnAction {
  if (reason & UsnReason.FILE_DELETE) return "delete";
  if (reason & UsnReason.RENAME_NEW_NAME) return "rename-new";
  if (reason & UsnReason.FILE_CREATE) return "create";
  if (reason & UsnReason.RENAME_OLD_NAME) return "rename-old";
  return "ignore";
}
