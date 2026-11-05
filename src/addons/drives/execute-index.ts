import { planIndexCommands, type PlanInput } from "@/addons/drives/commands";
import type { IndexDelta, IndexPayload, RawIndexedFile } from "@/addons/drives/types";

export interface IndexHandlers {
  readMft: () => Promise<{ files: RawIndexedFile[]; complete: boolean }>;
  readUsn: () => Promise<{ delta: IndexDelta | null }>;
  walk: () => Promise<{ files: RawIndexedFile[]; complete: boolean }>;
}

export interface ExecuteResult {
  payload: IndexPayload;
  called: Array<"readMft" | "readUsn" | "walk">;
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
  if (commands.some((command) => command.op === "pause")) {
    return {
      called,
      payload: {
        state: "paused",
        progress: 0,
        message: "Диск занят, индексация на паузе.",
        strategy,
      },
    };
  }
  if (strategy === "mft-usn") {
    called.push("readMft");
    try {
      const tree = await handlers.readMft();
      if (!tree.complete) {
        return {
          called,
          payload: {
            state: "error",
            progress: 0,
            strategy,
            message: "Чтение MFT не завершилось. Прежний каталог не изменён.",
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
      return { called, payload: { state: "complete", progress: 1, strategy, files: tree.files } };
    } catch {
      called.push("walk");
      const walked = await handlers.walk();
      if (!walked.complete) {
        return {
          called,
          payload: {
            state: "error",
            progress: 0,
            strategy: "walk",
            message: "MFT недоступна, обход папок не завершился. Прежний каталог не изменён.",
          },
        };
      }
      return {
        called,
        payload: {
          state: "complete",
          progress: 1,
          strategy: "walk",
          message: "MFT не прочиталась, выполнен обход папок.",
          files: walked.files,
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
