import path from "node:path";

import { demoLibraryRoot } from "@/addons/media-games/file-index/demo-volumes";
import { IndexError } from "@/addons/media-games/file-index/errors";
import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";
import { isMacVolumePath, isRawNtfsAllowed } from "@/addons/media-games/file-index/strategy";
import type {
  IndexFilesystem,
  IndexHit,
  IndexOs,
  IndexStatus,
  SearchOptions,
} from "@/addons/media-games/file-index/types";

export interface AgentBuildRequest {
  host?: string;
  volume?: string;
  filesystem?: string;
  walkRoot?: string;
  preferUsn?: boolean;
}

/**
 * Decision used by the Windows PC agent:
 * elevated + NTFS drive letter → MFT (full) or USN (when an NTFS index already exists);
 * otherwise a folder walk. macOS, APFS, and /Volumes never reach the raw reader.
 */
export class AgentFileIndex {
  private readonly index = new MemoryFileIndex();

  async health(): Promise<{ elevated: boolean; platform: NodeJS.Platform }> {
    return { elevated: await this.detectElevation(), platform: process.platform };
  }

  status(volume?: string): IndexStatus[] {
    return this.index.status(volume);
  }

  search(query: string, options?: SearchOptions): IndexHit[] {
    return this.index.search(query, options);
  }

  async build(body: AgentBuildRequest): Promise<IndexStatus> {
    const volume = String(body.volume || "").trim();
    if (!volume) throw new IndexError("Укажите том, например D:.");
    const os = osForVolume(volume);
    const filesystem = filesystemFor(body.filesystem, os);
    const elevated = os === "win32" ? await this.detectElevation() : false;
    const previous = this.index.status(volume)[0];
    const preferUsn =
      body.preferUsn === true ||
      (body.preferUsn !== false && (previous?.source === "mft" || previous?.source === "usn"));
    return this.index.indexVolume({
      host: body.host?.trim() || (os === "win32" ? "Windows PC" : "Mac mini"),
      volume,
      os,
      filesystem,
      elevated,
      preferUsn,
      walkRoot: resolveWalkRoot(body.walkRoot, volume, os),
      readNtfs: (source, target) => this.readNtfs(source, target),
    });
  }

  private async detectElevation(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const ntfs = await import("../../../../agents/pc-agent/win32/ntfs.ts");
      return await ntfs.isWindowsElevated();
    } catch {
      return false;
    }
  }

  private async readNtfs(source: "mft" | "usn", volume: string): Promise<Uint8Array> {
    if (process.platform !== "win32" || !isRawNtfsAllowed(volume)) {
      throw new IndexError("Чтение MFT и USN доступно только для тома NTFS в повышенном процессе Windows.");
    }
    const ntfs = await import("../../../../agents/pc-agent/win32/ntfs.ts");
    if (source === "mft") return (await ntfs.enumerateMft(volume)).records;
    return (await ntfs.readUsnJournal(volume, this.index.journalCursor(volume))).records;
  }
}

let singleton: AgentFileIndex | null = null;

export function agentIndex(): AgentFileIndex {
  if (!singleton) singleton = new AgentFileIndex();
  return singleton;
}

function osForVolume(volume: string): IndexOs {
  if (isMacVolumePath(volume) || volume.startsWith("/")) return "darwin";
  return "win32";
}

function filesystemFor(value: string | undefined, os: IndexOs): IndexFilesystem {
  if (os === "darwin") return "apfs";
  const text = (value || "").trim().toLowerCase();
  if (text === "apfs") return "apfs";
  if (text === "unknown") return "unknown";
  if (text === "ntfs" || text === "") return "ntfs";
  return "unknown";
}

function resolveWalkRoot(requested: string | undefined, volume: string, os: IndexOs): string {
  const demo = demoLibraryRoot();
  if (requested) {
    const resolved = path.resolve(requested);
    const insideDemo = resolved === demo || resolved.startsWith(demo + path.sep);
    if (insideDemo) return resolved;
    if (process.platform === "win32" && os === "win32") {
      const letter = volume.match(/[A-Za-z]/)?.[0];
      if (letter && path.win32.resolve(requested).toUpperCase().startsWith(`${letter.toUpperCase()}:`)) {
        return path.win32.resolve(requested);
      }
    }
    throw new IndexError("Обход разрешён для тома Windows или для демо-каталога агента.");
  }
  if (process.platform === "win32" && os === "win32") {
    const letter = volume.match(/^([A-Za-z]):/)?.[1];
    if (letter) return `${letter.toUpperCase()}:\\`;
  }
  throw new IndexError("Не задан каталог для обхода.");
}
