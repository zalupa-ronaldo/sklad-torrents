import { planIndexCommands, type PlanInput } from "@/addons/drives/commands";
import { isNtfs } from "@/addons/drives/strategy";
import type { DirStub } from "@/addons/drives/ntfs-mft";
import type { IndexCheckpoint, IndexDelta, IndexPayload, RawIndexedFile } from "@/addons/drives/types";

export interface MftChunk {
  files: RawIndexedFile[];
  complete: boolean;
  paused?: boolean;
  recordsRead?: number;
  recordsTotal?: number | null;
  mftOffset?: number | null;
  currentFile?: string | null;
  processedBytes?: number;
  dirs?: DirStub[];
}

export interface IndexHandlers {
  readMft: (cursor?: IndexCheckpoint) => Promise<MftChunk>;
  readUsn: () => Promise<{ delta: IndexDelta | null }>;
  walk: () => Promise<{ files: RawIndexedFile[]; complete: boolean }>;
}

export interface ExecuteResult {
  payload: IndexPayload;
  called: Array<"readMft" | "readUsn" | "walk">;
  /** Directory stubs for the next resume. Not part of the published catalog. */
  dirs?: DirStub[];
}

function unfinished(message: string, strategy: IndexPayload["strategy"]): IndexPayload {
  return { state: "error", progress: 0, message, strategy };
}

/**
 * Runs only the read-only plan: pause, MFT, USN, or a filesystem walk.
 * An incomplete read is an error and does not publish a tree.
 */
export async function executeIndexPlan(input: PlanInput, handlers: IndexHandlers): Promise<ExecuteResult> {
  const commands = planIndexCommands(input);
  const called: ExecuteResult["called"] = [];
  const strategy = commands.some((command) => command.op === "read-mft") ? "mft-usn" : "walk";
  if (isNtfs(input.filesystem) && input.platform === "win32" && !input.elevated && !input.busy) {
    return {
      called,
      payload: {
        state: "error",
        progress: 0,
        strategy: "mft-usn",
        message:
          "NTFS читается только дампом MFT. Нет прав администратора, обход папок не запускался. Запустите drive-agent от администратора и повторите чтение MFT.",
      },
    };
  }
  if (commands.some((command) => command.op === "pause")) {
    const done = input.cursor?.recordsDone ?? 0;
    const total = input.cursor?.recordsTotal ?? null;
    return {
      called,
      payload: {
        state: "paused",
        progress: total && total > 0 ? Math.min(0.99, done / total) : 0,
        message: "Диск занят, индексация на паузе.",
        strategy,
        pauseReason: "busy",
        checkpoint: input.cursor,
      },
    };
  }
  if (strategy === "mft-usn") {
    called.push("readMft");
    try {
      const tree = await handlers.readMft(input.cursor);
      if (tree.paused) {
        const done = tree.recordsRead ?? input.cursor?.recordsDone ?? 0;
        const total = tree.recordsTotal ?? input.cursor?.recordsTotal ?? null;
        return {
          called,
          payload: {
            state: "paused",
            progress: total && total > 0 ? Math.min(0.99, done / total) : 0,
            strategy,
            message: "Индексация на паузе. Продолжение с места остановки.",
            pauseReason: "user",
            currentFile: tree.currentFile ?? null,
            processedBytes: tree.processedBytes,
            checkpoint: {
              recordsDone: done,
              recordsTotal: total,
              mftOffset: tree.mftOffset ?? input.cursor?.mftOffset ?? null,
              nextUsn: input.cursor?.nextUsn ?? null,
            },
            files: tree.files,
          },
          dirs: tree.dirs,
        };
      }
      if (!tree.complete) {
        return {
          called,
          payload: {
            state: "error",
            progress: 0,
            strategy,
            message: "Чтение MFT не завершилось. Обход папок не запускался. Прежний каталог не изменён.",
          },
        };
      }
      called.push("readUsn");
      let delta: IndexDelta | null = null;
      try {
        delta = (await handlers.readUsn()).delta;
      } catch {
        delta = null;
      }
      if (input.usnCheckpoint && delta?.complete) {
        return { called, payload: { state: "complete", progress: 1, strategy, delta } };
      }
      return { called, payload: { state: "complete", progress: 1, strategy, files: tree.files }, dirs: tree.dirs };
    } catch {
      return {
        called,
        payload: {
          state: "error",
          progress: 0,
          strategy: "mft-usn",
          message: "Чтение MFT не выполнилось. Обход папок не запускался. Прежний каталог не изменён. Повторите снимок MFT, когда том доступен.",
        },
      };
    }
  }
  called.push("walk");
  const walked = await handlers.walk();
  if (!walked.complete) {
    return {
      called,
      payload: unfinished("Обход папок не завершился. Прежний каталог не изменён.", "walk"),
    };
  }
  return { called, payload: { state: "complete", progress: 1, strategy: "walk", files: walked.files } };
}
