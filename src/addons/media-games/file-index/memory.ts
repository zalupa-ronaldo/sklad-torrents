import type {
  FileIndexer,
  IndexHit,
  IndexSource,
  IndexStatus,
  IndexVolumeRequest,
  SearchOptions,
} from "@/addons/media-games/file-index/types";
import { IndexError } from "@/addons/media-games/file-index/errors";
import { NTFS_ROOT_RECORD, parseMftFixture } from "@/addons/media-games/file-index/mft";
import {
  chooseIndexStrategy,
  explainStrategy,
  isRawNtfsAllowed,
  strategyInputOf,
} from "@/addons/media-games/file-index/strategy";
import {
  buildTreePaths,
  displayRoot,
  isNtfsRoot,
  joinSegment,
  type TreeNode,
  volumeKey,
} from "@/addons/media-games/file-index/tree";
import {
  classifyUsn,
  FILE_ATTRIBUTE_DIRECTORY,
  parseUsnRecords,
  type ParsedUsnRecord,
} from "@/addons/media-games/file-index/usn";
import { walkDirectory } from "@/addons/media-games/file-index/walk";

interface StoredNode extends TreeNode {
  source: IndexSource;
  path: string;
  usn: bigint;
}

interface VolumeState {
  host: string;
  volume: string;
  os: IndexVolumeRequest["os"];
  filesystem: IndexVolumeRequest["filesystem"];
  source: IndexSource;
  elevated: boolean;
  lastBuilt: string;
  message: string;
  nodes: Map<string, StoredNode>;
  nextUsn: bigint;
}

const WALK_REF_BASE = 1_000_000n;

/**
 * In-memory index shared by tests, the Mac folder walk, and the Windows PC agent.
 * MFT fixtures and USN records only change a volume after `chooseIndexStrategy`
 * returns `mft` or `usn`.
 */
export class MemoryFileIndex implements FileIndexer {
  private readonly volumes = new Map<string, VolumeState>();

  async indexVolume(request: IndexVolumeRequest): Promise<IndexStatus> {
    const strategy = chooseIndexStrategy(request);
    if (strategy === "walk") {
      return this.fillFromWalk(request);
    }
    try {
      if (strategy === "mft") {
        const bytes = request.mftFixture ?? (await this.readNtfsBytes(request, "mft"));
        const nodes = nodesFromNtfsSnapshot(bytes);
        return this.replaceTree(request, nodes, "mft");
      }
      const bytes = request.usnJournal ?? (await this.readNtfsBytes(request, "usn"));
      return this.applyJournal(request, parseUsnRecords(bytes));
    } catch (error) {
      if (!request.walkRoot) throw error;
      await this.fillFromWalk(request);
      const detail = error instanceof Error ? error.message : "не удалось прочитать NTFS";
      const message = `Индекс MFT недоступен (${detail}). Результаты получены обходом папок.`;
      const state = this.requireVolume(request.volume);
      state.message = message;
      state.source = "walk";
      return this.toStatus(state);
    }
  }

  search(query: string, options: SearchOptions = {}): IndexHit[] {
    const limit = options.limit ?? 80;
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    const tokens = needle.split(/\s+/).filter(Boolean);
    const hits: IndexHit[] = [];
    for (const state of this.volumes.values()) {
      if (options.volume && volumeKey(options.volume) !== volumeKey(state.volume)) continue;
      if (options.host && options.host !== state.host) continue;
      for (const node of state.nodes.values()) {
        if (isNtfsRoot(node)) continue;
        if (options.directoriesOnly && !node.isDirectory) continue;
        if (!matches(tokens, node)) continue;
        hits.push({
          host: state.host,
          path: node.path,
          name: node.name,
          size: node.size,
          isDirectory: node.isDirectory,
          source: node.source,
          volume: state.volume,
        });
      }
    }
    hits.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path, "ru"));
    return hits.slice(0, limit);
  }

  status(volume?: string): IndexStatus[] {
    const states = volume
      ? [this.volumes.get(volumeKey(volume))].filter((state): state is VolumeState => Boolean(state))
      : [...this.volumes.values()];
    return states.map((state) => this.toStatus(state));
  }

  /** Next USN the Windows agent should ask the journal for. `0n` when the volume is unknown. */
  journalCursor(volume: string): bigint {
    return this.volumes.get(volumeKey(volume))?.nextUsn ?? 0n;
  }

  dropVolume(volume: string): void {
    this.volumes.delete(volumeKey(volume));
  }

  private async fillFromWalk(request: IndexVolumeRequest): Promise<IndexStatus> {
    if (!request.walkRoot) {
      throw new IndexError("Для обхода папок нужен каталог walkRoot.");
    }
    const items = await walkDirectory(request.walkRoot);
    const separator = request.os === "win32" ? "\\" : "/";
    const rootPath = displayRoot(request.volume, request.os);
    const nodes = new Map<string, StoredNode>();
    let nextRef = WALK_REF_BASE;
    for (const item of items) {
      const fileRef = nextRef;
      nextRef += 1n;
      let cursor = rootPath;
      for (const part of item.relativePath.split(/[/\\]/).filter(Boolean)) {
        cursor = joinSegment(cursor, part, separator);
      }
      const node: StoredNode = {
        fileRef,
        parentRef: 0n,
        name: item.name,
        size: item.size,
        isDirectory: item.isDirectory,
        source: "walk",
        path: cursor,
        usn: 0n,
      };
      nodes.set(fileRef.toString(), node);
    }
    const input = strategyInputOf(request);
    const state: VolumeState = {
      host: request.host,
      volume: volumeKey(request.volume),
      os: request.os,
      filesystem: request.filesystem,
      source: "walk",
      elevated: request.elevated,
      lastBuilt: new Date().toISOString(),
      message: request.notice ?? explainStrategy(input, "walk"),
      nodes,
      nextUsn: 0n,
    };
    this.volumes.set(state.volume, state);
    return this.toStatus(state);
  }

  private replaceTree(
    request: IndexVolumeRequest,
    tree: Array<TreeNode & { usn?: bigint }>,
    source: "mft" | "usn",
  ): IndexStatus {
    assertNtfsMutation(request);
    const nodes = new Map<string, StoredNode>();
    let nextUsn = 0n;
    for (const entry of tree) {
      const usn = entry.usn ?? 0n;
      if (usn + 1n > nextUsn) nextUsn = usn + 1n;
      nodes.set(entry.fileRef.toString(), {
        ...entry,
        source,
        path: "",
        usn,
      });
    }
    const state = this.blankState(request, source, nodes);
    state.nextUsn = nextUsn;
    repath(state);
    this.volumes.set(state.volume, state);
    return this.toStatus(state);
  }

  private applyJournal(request: IndexVolumeRequest, records: ParsedUsnRecord[]): IndexStatus {
    assertNtfsMutation(request);
    const existing = this.volumes.get(volumeKey(request.volume));
    const state = existing ?? this.blankState(request, "usn", new Map());
    state.host = request.host;
    state.os = request.os;
    state.filesystem = request.filesystem;
    state.elevated = request.elevated;
    state.source = "usn";
    state.lastBuilt = new Date().toISOString();
    state.message = explainStrategy(strategyInputOf(request), "usn");
    for (const record of records) {
      applyRecord(state, record);
      if (record.usn + 1n > state.nextUsn) state.nextUsn = record.usn + 1n;
    }
    repath(state);
    this.volumes.set(state.volume, state);
    return this.toStatus(state);
  }

  private blankState(request: IndexVolumeRequest, source: IndexSource, nodes: Map<string, StoredNode>): VolumeState {
    return {
      host: request.host,
      volume: volumeKey(request.volume),
      os: request.os,
      filesystem: request.filesystem,
      source,
      elevated: request.elevated,
      lastBuilt: new Date().toISOString(),
      message: explainStrategy(strategyInputOf(request), source),
      nodes,
      nextUsn: 0n,
    };
  }

  private async readNtfsBytes(request: IndexVolumeRequest, source: "mft" | "usn"): Promise<Uint8Array> {
    assertNtfsMutation(request);
    if (!request.readNtfs) {
      throw new IndexError("Нет читателя NTFS. На Windows его даёт агент ПК с правами администратора.");
    }
    return request.readNtfs(source, volumeKey(request.volume));
  }

  private requireVolume(volume: string): VolumeState {
    const state = this.volumes.get(volumeKey(volume));
    if (!state) throw new IndexError("Том не проиндексирован.");
    return state;
  }

  private toStatus(state: VolumeState): IndexStatus {
    let fileCount = 0;
    for (const node of state.nodes.values()) {
      if (!isNtfsRoot(node)) fileCount += 1;
    }
    return {
      source: state.source,
      volume: state.volume,
      fileCount,
      lastBuilt: state.lastBuilt,
      elevated: state.elevated,
      host: state.host,
      message: state.message,
    };
  }
}

function assertNtfsMutation(request: IndexVolumeRequest): void {
  if (!isRawNtfsAllowed(request.volume) || request.os === "darwin" || request.filesystem === "apfs") {
    throw new IndexError("MFT и USN не применяются к APFS и путям /Volumes.");
  }
}

function nodesFromNtfsSnapshot(bytes: Uint8Array): Array<TreeNode & { usn?: bigint }> {
  if (isMftFixture(bytes)) {
    return parseMftFixture(bytes)
      .filter((entry) => entry.inUse)
      .map((entry) => ({
        fileRef: entry.recordNumber,
        parentRef: entry.parentRecord,
        name: entry.name,
        size: entry.size,
        isDirectory: entry.isDirectory,
        usn: 0n,
      }));
  }
  // FSCTL_ENUM_USN_DATA returns USN_RECORD_V2 rows for the files the MFT currently holds.
  return parseUsnRecords(bytes).map((record) => ({
    fileRef: record.fileRef,
    parentRef: record.parentRef,
    name: record.name,
    size: 0,
    isDirectory: (record.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
    usn: record.usn,
  }));
}

function isMftFixture(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x46 && bytes[1] === 0x49 && bytes[2] === 0x4c && bytes[3] === 0x45;
}

function applyRecord(state: VolumeState, record: ParsedUsnRecord): void {
  const action = classifyUsn(record.reason);
  const key = record.fileRef.toString();
  if (action === "ignore") return;
  if (action === "delete") {
    for (const ref of subtree(state, record.fileRef)) state.nodes.delete(ref.toString());
    return;
  }
  if (action === "rename-old") {
    if (!state.nodes.has(key)) insertNode(state, record, "usn");
    return;
  }
  insertNode(state, record, "usn");
}

function insertNode(state: VolumeState, record: ParsedUsnRecord, source: IndexSource): void {
  const previous = state.nodes.get(record.fileRef.toString());
  state.nodes.set(record.fileRef.toString(), {
    fileRef: record.fileRef,
    parentRef: record.parentRef,
    name: record.name,
    size: previous?.size ?? 0,
    isDirectory: (record.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 || previous?.isDirectory === true,
    source,
    path: "",
    usn: record.usn,
  });
}

function subtree(state: VolumeState, root: bigint): bigint[] {
  const children = new Map<string, bigint[]>();
  for (const node of state.nodes.values()) {
    const list = children.get(node.parentRef.toString()) ?? [];
    list.push(node.fileRef);
    children.set(node.parentRef.toString(), list);
  }
  const out: bigint[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const ref = stack.pop();
    if (ref === undefined) break;
    const key = ref.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    for (const child of children.get(key) ?? []) stack.push(child);
  }
  return out;
}

function repath(state: VolumeState): void {
  const separator = state.os === "win32" ? "\\" : "/";
  const rootPath = displayRoot(state.volume, state.os);
  const paths = buildTreePaths([...state.nodes.values()], rootPath, separator);
  for (const node of state.nodes.values()) {
    if (node.fileRef === NTFS_ROOT_RECORD || isNtfsRoot(node)) {
      node.path = rootPath;
      node.name = node.name || ".";
      continue;
    }
    const built = paths.get(node.fileRef);
    if (built) node.path = built;
  }
}

function matches(tokens: string[], node: StoredNode): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${node.name}\n${node.path}`.toLocaleLowerCase("ru-RU");
  return tokens.every((token) => haystack.includes(token));
}
