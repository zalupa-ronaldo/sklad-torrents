export interface FolderPlace {
  diskId: string | null;
  path: string;
}

export interface FolderHistory {
  entries: FolderPlace[];
  index: number;
}

function normalize(place: FolderPlace): FolderPlace {
  return { diskId: place.diskId || null, path: place.path || "" };
}

function same(left: FolderPlace, right: FolderPlace): boolean {
  return left.diskId === right.diskId && left.path === right.path;
}

export function createFolderHistory(start: FolderPlace = { diskId: null, path: "" }): FolderHistory {
  return { entries: [normalize(start)], index: 0 };
}

export function currentPlace(history: FolderHistory): FolderPlace {
  return history.entries[history.index] ?? { diskId: null, path: "" };
}

export function canGoBack(history: FolderHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: FolderHistory): boolean {
  return history.index < history.entries.length - 1;
}

/** Opening a folder drops the forward branch and records one new place. The same place is not stacked twice. */
export function pushPlace(history: FolderHistory, place: FolderPlace): FolderHistory {
  const next = normalize(place);
  if (same(currentPlace(history), next)) return history;
  const entries = history.entries.slice(0, history.index + 1);
  entries.push(next);
  return { entries, index: entries.length - 1 };
}

export function goBack(history: FolderHistory): FolderHistory {
  if (!canGoBack(history)) return history;
  return { entries: history.entries, index: history.index - 1 };
}

export function goForward(history: FolderHistory): FolderHistory {
  if (!canGoForward(history)) return history;
  return { entries: history.entries, index: history.index + 1 };
}

/** Point every history step that used a retired duplicate id at the disk that kept the files. */
export function retargetDisk(history: FolderHistory, from: string, to: string): FolderHistory {
  if (!from || from === to) return history;
  return {
    index: history.index,
    entries: history.entries.map((entry) => (entry.diskId === from ? { ...entry, diskId: to } : entry)),
  };
}
