import { UsnReason } from "@/addons/media-games/file-index/usn";

/** CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 61, METHOD_BUFFERED, FILE_ANY_ACCESS). */
export const FSCTL_QUERY_USN_JOURNAL = 0x000900f4;

/** CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 46, METHOD_NEITHER, FILE_ANY_ACCESS). */
export const FSCTL_READ_USN_JOURNAL = 0x000900bb;

/** USN_JOURNAL_DATA_V0 is 56 bytes. Later versions only append fields. */
export const USN_JOURNAL_DATA_V0_BYTES = 56;

/** READ_USN_JOURNAL_DATA_V0 is 40 bytes. */
export const READ_USN_JOURNAL_DATA_V0_BYTES = 40;

const READ_REASON_MASK =
  (UsnReason.DATA_OVERWRITE |
    UsnReason.DATA_EXTEND |
    UsnReason.DATA_TRUNCATION |
    UsnReason.FILE_CREATE |
    UsnReason.FILE_DELETE |
    UsnReason.RENAME_OLD_NAME |
    UsnReason.RENAME_NEW_NAME |
    UsnReason.CLOSE) >>>
  0;

export interface UsnJournalInfo {
  journalId: bigint;
  firstUsn: bigint;
  nextUsn: bigint;
  lowestValidUsn: bigint;
  maxUsn: bigint;
  maximumSize: bigint;
  allocationDelta: bigint;
}

export function encodeUsnJournalData(info: UsnJournalInfo): Buffer {
  const buf = Buffer.alloc(USN_JOURNAL_DATA_V0_BYTES);
  buf.writeBigUInt64LE(info.journalId, 0);
  buf.writeBigInt64LE(info.firstUsn, 8);
  buf.writeBigInt64LE(info.nextUsn, 16);
  buf.writeBigInt64LE(info.lowestValidUsn, 24);
  buf.writeBigInt64LE(info.maxUsn, 32);
  buf.writeBigUInt64LE(info.maximumSize, 40);
  buf.writeBigUInt64LE(info.allocationDelta, 48);
  return buf;
}

export function parseUsnJournalData(bytes: Uint8Array): UsnJournalInfo {
  const buf = Buffer.from(bytes);
  if (buf.length < USN_JOURNAL_DATA_V0_BYTES) {
    throw new Error("Ответ FSCTL_QUERY_USN_JOURNAL короче USN_JOURNAL_DATA_V0.");
  }
  return {
    journalId: buf.readBigUInt64LE(0),
    firstUsn: buf.readBigInt64LE(8),
    nextUsn: buf.readBigInt64LE(16),
    lowestValidUsn: buf.readBigInt64LE(24),
    maxUsn: buf.readBigInt64LE(32),
    maximumSize: buf.readBigUInt64LE(40),
    allocationDelta: buf.readBigUInt64LE(48),
  };
}

/**
 * A saved cursor cannot be continued when Windows replaced the journal or the
 * next record we need has already fallen out of LowestValidUsn.
 */
export function usnJournalLost(
  saved: { journalId: string; nextUsn: string },
  live: { journalId: string; lowestValidUsn: string; nextUsn: string },
): boolean {
  if (saved.journalId !== live.journalId) return true;
  const savedNext = BigInt(saved.nextUsn);
  if (BigInt(live.lowestValidUsn) > savedNext) return true;
  if (BigInt(live.nextUsn) < savedNext) return true;
  return false;
}

/** READ_USN_JOURNAL_DATA_V0. ReturnOnlyOnClose is 1 so a half-written file is not indexed. */
export function encodeReadUsnJournal(input: { startUsn: bigint; journalId: bigint }): Buffer {
  const buf = Buffer.alloc(READ_USN_JOURNAL_DATA_V0_BYTES);
  buf.writeBigInt64LE(input.startUsn, 0);
  buf.writeUInt32LE(READ_REASON_MASK, 8);
  buf.writeUInt32LE(1, 12);
  buf.writeBigUInt64LE(0n, 16);
  buf.writeBigUInt64LE(0n, 24);
  buf.writeBigUInt64LE(input.journalId, 32);
  return buf;
}

/** The read ioctl prefixes USN_RECORD_V2 with the next USN (8 bytes). */
export function splitUsnRead(bytes: Uint8Array): { nextUsn: bigint; records: Buffer } {
  const buf = Buffer.from(bytes);
  if (buf.length < 8) throw new Error("Ответ FSCTL_READ_USN_JOURNAL короче курсора USN.");
  return { nextUsn: buf.readBigInt64LE(0), records: buf.subarray(8) };
}
