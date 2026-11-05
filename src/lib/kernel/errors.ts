export class SkladError extends Error {
  readonly code: "validation" | "not_found" | "conflict" | "unavailable";

  constructor(code: SkladError["code"], message: string) {
    super(message);
    this.name = "SkladError";
    this.code = code;
  }
}
