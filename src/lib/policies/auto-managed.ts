import { dataFile, readJsonFile, writeJsonFile } from "@/lib/json-file";

export interface AutoManagedState {
  /** Existing torrents snapshotted when automation was first enabled — never auto-moved. */
  ignored: string[];
  /** Torrents added via UI (or newly seen after baseline) that automation may place. */
  managed: string[];
  baselineAt: number | null;
}

function key(hostId: string, hash: string): string {
  return `${hostId}:${hash.toLowerCase()}`;
}

function empty(): AutoManagedState {
  return { ignored: [], managed: [], baselineAt: null };
}

export async function loadAutoManaged(): Promise<AutoManagedState> {
  const file = await readJsonFile<Partial<AutoManagedState>>(dataFile("auto-managed.json"), {});
  return {
    ignored: Array.isArray(file.ignored) ? file.ignored.filter((item) => typeof item === "string") : [],
    managed: Array.isArray(file.managed) ? file.managed.filter((item) => typeof item === "string") : [],
    baselineAt: typeof file.baselineAt === "number" ? file.baselineAt : null,
  };
}

async function save(state: AutoManagedState): Promise<void> {
  await writeJsonFile(dataFile("auto-managed.json"), state);
}

/** First enable: freeze current torrents so they are never relocated by automation. */
export async function ensureBaseline(current: { hostId: string; hash: string }[]): Promise<AutoManagedState> {
  const state = await loadAutoManaged();
  if (state.baselineAt != null) return state;
  const ignored = [...new Set(current.map((item) => key(item.hostId, item.hash)))];
  const next = { ignored, managed: state.managed, baselineAt: Date.now() };
  await save(next);
  return next;
}

export async function markManaged(hostId: string, hash: string): Promise<void> {
  if (!hostId || !hash) return;
  const state = await loadAutoManaged();
  const id = key(hostId, hash);
  if (state.managed.includes(id)) return;
  const ignored = state.ignored.filter((item) => item !== id);
  await save({ ...state, ignored, managed: [...state.managed, id] });
}

export async function markManagedMany(items: { hostId: string; hash: string }[]): Promise<void> {
  if (items.length === 0) return;
  const state = await loadAutoManaged();
  const managed = new Set(state.managed);
  const ignored = new Set(state.ignored);
  for (const item of items) {
    const id = key(item.hostId, item.hash);
    managed.add(id);
    ignored.delete(id);
  }
  await save({ ...state, managed: [...managed], ignored: [...ignored] });
}

export function isAutoEligible(
  state: AutoManagedState,
  hostId: string,
  hash: string,
  addedOn: number,
): boolean {
  const id = key(hostId, hash);
  if (state.ignored.includes(id)) return false;
  if (state.managed.includes(id)) return true;
  if (state.baselineAt == null || !(addedOn > 0)) return false;
  const addedMs = addedOn > 1_000_000_000_000 ? addedOn : addedOn * 1000;
  return addedMs > state.baselineAt;
}
