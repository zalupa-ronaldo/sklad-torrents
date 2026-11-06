/** Above this, file pages are not downloaded inside the shelf request. */
export const LARGE_INDEX_RECORDS = 20_000;

export function indexFetchPlan(input: {
  state?: string;
  revision?: string;
  recordCount?: number;
  knownRevision?: string;
  pendingRevision?: string;
}): "none" | "skip" | "inline" | "defer" {
  if (!input.revision || input.state !== "complete") return "none";
  const count = input.recordCount ?? 0;
  if (count <= 0) return "none";
  if (input.knownRevision === input.revision || input.pendingRevision === input.revision) return "skip";
  if (count >= LARGE_INDEX_RECORDS) return "defer";
  return "inline";
}
