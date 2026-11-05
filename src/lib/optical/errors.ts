export const AGENT_OFFLINE = "агент Windows недоступен";

export type OpticalErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "tool_not_found"
  | "offline"
  | "forbidden";

export class OpticalError extends Error {
  readonly code: OpticalErrorCode;

  constructor(code: OpticalErrorCode, message: string) {
    super(message);
    this.name = "OpticalError";
    this.code = code;
  }
}
