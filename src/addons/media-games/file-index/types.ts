/** How an index entry was produced. Never spelled as anything but MFT / USN / walk. */
export type IndexSource = "mft" | "usn" | "walk";

export type IndexOs = "darwin" | "win32" | "linux";

export type IndexFilesystem = "ntfs" | "apfs" | "unknown";

/**
 * What the dashboard and the PC agent both understand.
 * `source` is the method that actually answered: NTFS MFT, the USN journal, or a folder walk.
 */
export interface IndexStatus {
  source: IndexSource;
  volume: string;
  fileCount: number;
  /** ISO-8601 time of the last successful build, or null before the first build. */
  lastBuilt: string | null;
  elevated: boolean;
  host: string;
  /** Russian explanation shown in the Media & Games addon. */
  message: string;
}

export interface IndexHit {
  host: string;
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  source: IndexSource;
  volume: string;
}

export interface IndexVolumeRequest {
  host: string;
  /**
   * Volume or root. Windows: `D:`, `D:\`, `\\.\D:`.
   * Mac: `/Volumes/vault` and anything under `/Volumes`.
   */
  volume: string;
  os: IndexOs;
  filesystem?: IndexFilesystem;
  /** Windows process is elevated and may open the raw volume. Ignored for APFS. */
  elevated: boolean;
  /**
   * Elevated NTFS only: apply the USN journal instead of rebuilding from the MFT.
   * Has no effect when the strategy is a folder walk.
   */
  preferUsn?: boolean;
  /** Directory listing used when the strategy is `walk`. */
  walkRoot?: string;
  /** Replaces the default walk explanation. Ignored for an MFT or USN build. */
  notice?: string;
  /**
   * Synthetic MFT fixture (signature `FILE`). Used by tests and never read from a live disk.
   * Ignored unless the strategy is `mft`.
   */
  mftFixture?: Uint8Array;
  /**
   * Synthetic or real USN_RECORD_V2 bytes. Ignored unless the strategy is `usn`.
   */
  usnJournal?: Uint8Array;
  /**
   * Windows-only reader (raw volume / DeviceIoControl). Called only after the strategy
   * resolves to `mft` or `usn`, and never for Mac or `/Volumes/...`.
   */
  readNtfs?: (source: "mft" | "usn", volume: string) => Promise<Uint8Array>;
}

export interface SearchOptions {
  volume?: string;
  host?: string;
  directoriesOnly?: boolean;
  limit?: number;
}

export interface FileIndexer {
  indexVolume(request: IndexVolumeRequest): Promise<IndexStatus>;
  search(query: string, options?: SearchOptions): IndexHit[];
  status(volume?: string): IndexStatus[];
}
