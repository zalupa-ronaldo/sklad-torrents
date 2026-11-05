import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ToolsError } from "@/addons/media-games/errors";
import { assertDeletableFolder, buildVerifyResult, type FolderMoveAdapter } from "@/addons/media-games/move";
import type { ToolOs, VerifyResult } from "@/addons/media-games/types";

let spawnCount = 0;

interface LiveProcess {
  progress: number;
  code: number | null;
  error: string | null;
}

const live = new Map<string, LiveProcess>();

export function getSpawnCount(): number {
  return spawnCount;
}

export function resetSpawnCount(): void {
  spawnCount = 0;
}

export function binaryExists(filePath: string): boolean {
  if (!filePath.trim()) return false;
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

export function readTracked(id: string): LiveProcess | null {
  return live.get(id) ?? null;
}

/** Spawns a real binary. Callers must skip this in demo mode. compact.exe is refused off Windows. */
export function startTracked(id: string, argv: string[], os: ToolOs, kind: "transcode" | "compress"): void {
  if (argv.length === 0) throw new ToolsError("validation", "Пустая команда.");
  if (kind === "compress" && (os !== "win32" || process.platform !== "win32")) {
    throw new ToolsError("unavailable", "Только Windows, NTFS. compact.exe не запускается на этой системе.");
  }
  const bin = argv[0];
  if (!binaryExists(bin)) {
    throw new ToolsError("unavailable", `Не найден файл программы: ${bin}`);
  }
  spawnCount += 1;
  const child: ChildProcess = spawn(bin, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  const entry: LiveProcess = { progress: 0.05, code: null, error: null };
  live.set(id, entry);
  const onData = (buf: Buffer) => {
    const match = /(\d+(?:\.\d+)?)\s*%/.exec(buf.toString());
    if (!match) return;
    const value = Number(match[1]);
    if (Number.isFinite(value)) entry.progress = Math.max(entry.progress, Math.min(0.99, value / 100));
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => {
    entry.error = error.message;
    entry.code = -1;
  });
  child.on("close", (code) => {
    entry.code = code ?? -1;
    if (code === 0) entry.progress = 1;
  });
}

export function createFsMover(os: ToolOs): FolderMoveAdapter {
  return {
    async copy(source, destination) {
      try {
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : "копирование не удалось";
        throw new ToolsError("unavailable", `Не удалось скопировать папку: ${message}`);
      }
      const measured = await measureTree(destination);
      return { files: measured.files, bytes: measured.bytes, marker: destination };
    },
    async verify(source, destination, receipt) {
      const sourceTree = await measureTree(source);
      const destTree = await measureTree(destination);
      const ok =
        sourceTree.files === destTree.files &&
        sourceTree.bytes === destTree.bytes &&
        sourceTree.hash === destTree.hash &&
        sourceTree.files === receipt.files &&
        sourceTree.bytes === receipt.bytes;
      if (!ok) {
        return {
          ok: false,
          sourceFiles: sourceTree.files,
          destFiles: destTree.files,
          sourceBytes: sourceTree.bytes,
          destBytes: destTree.bytes,
          sourceHash: sourceTree.hash,
          destHash: destTree.hash,
          message: "Проверка не сошлась. Исходная папка не удаляется.",
        } satisfies VerifyResult;
      }
      const result = buildVerifyResult({ files: sourceTree.files, bytes: sourceTree.bytes }, true);
      return { ...result, sourceHash: sourceTree.hash, destHash: destTree.hash };
    },
    async deleteSource(source) {
      const folder = assertDeletableFolder(os, source);
      await rm(folder, { recursive: true, force: false });
    },
  };
}

async function measureTree(root: string): Promise<{ files: number; bytes: number; hash: string }> {
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full);
      files += 1;
      bytes += info.size;
      lines.push(`${path.relative(root, full).replace(/\\/g, "/")} ${info.size}`);
    }
  }
  try {
    const info = await stat(root);
    if (info.isFile()) {
      files = 1;
      bytes = info.size;
      lines.push(`${path.basename(root)} ${info.size}`);
    } else {
      await walk(root);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "нет доступа";
    throw new ToolsError("unavailable", `Не удалось прочитать ${root}: ${message}`);
  }
  lines.sort();
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
  return { files, bytes, hash };
}
