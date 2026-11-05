export type QbErrorCode =
  | "auth"
  | "network"
  | "http"
  | "api"
  | "not_found"
  | "validation";

export class QbittorrentError extends Error {
  readonly code: QbErrorCode;

  constructor(code: QbErrorCode, message: string) {
    super(message);
    this.name = "QbittorrentError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof QbittorrentError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Не получилось выполнить запрос.";
}
