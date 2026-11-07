/** Above this, file pages are not downloaded inside the shelf request. */
export const LARGE_INDEX_RECORDS = 20_000;

export function indexFetchPlan(input: {
  state?: string;
  revision?: string;
  recordCount?: number;
  knownRevision?: string;
  pendingRevision?: string;
  /** Files actually stored locally. A matching revision with nothing stored must be downloaded again. */
  localRecords?: number;
}): "none" | "skip" | "inline" | "defer" {
  if (!input.revision || input.state !== "complete") return "none";
  const count = input.recordCount ?? 0;
  if (count <= 0) return "none";
  if (input.pendingRevision === input.revision) return "skip";
  const local = input.localRecords ?? 0;
  if (input.knownRevision === input.revision && local > 0) return "skip";
  if (count >= LARGE_INDEX_RECORDS) return "defer";
  return "inline";
}
