/**
 * LocalSend protocol v2.
 * Source: https://github.com/localsend/protocol/blob/main/README.md
 *
 * Defaults: UDP multicast 224.0.0.167:53317, HTTP(S) TCP 53317.
 * Upload: POST /api/localsend/v2/prepare-upload, then
 * POST /api/localsend/v2/upload?sessionId&fileId&token, cancel on
 * POST /api/localsend/v2/cancel?sessionId.
 */

export const LOCALSEND_PORT = 53317;
export const LOCALSEND_MULTICAST_ADDRESS = "224.0.0.167";
export const PROTOCOL_VERSION = "2.1";

export type LocalProtocol = "http" | "https";

export interface DeviceInfo {
  alias: string;
  version: string;
  deviceModel?: string | null;
  deviceType?: string | null;
  fingerprint: string;
  port?: number;
  protocol?: LocalProtocol;
  download?: boolean;
  announce?: boolean;
}

export interface FileMetadata {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
  sha256?: string | null;
  preview?: string | null;
  metadata?: {
    modified?: string | null;
    accessed?: string | null;
  } | null;
}

export interface PrepareUploadRequest {
  info: DeviceInfo;
  files: Record<string, FileMetadata>;
}

export interface PrepareUploadResponse {
  sessionId: string;
  files: Record<string, string | null>;
}

export function protocolStatusMessage(status: number): string {
  switch (status) {
    case 204:
      return "204 Finished (No file transfer needed)";
    case 400:
      return "400 Invalid body";
    case 401:
      return "401 PIN required / Invalid PIN";
    case 403:
      return "403 Rejected";
    case 409:
      return "409 Blocked by another session";
    case 422:
      return "422 Checksum mismatch (sha256)";
    case 429:
      return "429 Too many requests";
    case 500:
      return "500 Unknown error by receiver";
    default:
      return `HTTP ${status}`;
  }
}

export function normalizeFingerprint(value: string): string {
  const compact = value.trim().toLowerCase().replace(/:/g, "");
  if (/^[0-9a-f]{64}$/.test(compact)) return compact;
  return value.trim().toLowerCase();
}

export function fileTypeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "txt":
    case "nfo":
      return "text/plain";
    case "json":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "mp4":
      return "video/mp4";
    case "mkv":
      return "video/x-matroska";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
