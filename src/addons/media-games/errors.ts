export type ToolsErrorCode = "validation" | "not_found" | "unavailable";

export class ToolsError extends Error {
  readonly code: ToolsErrorCode;

  constructor(code: ToolsErrorCode, message: string) {
    super(message);
    this.name = "ToolsError";
    this.code = code;
  }
}

export function toolsErrorMessage(error: unknown): string {
  if (error instanceof ToolsError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Не получилось выполнить задание.";
}
