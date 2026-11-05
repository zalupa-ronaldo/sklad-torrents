import { MOCK_GAMES } from "../../src/addons/drives/mock-ids.ts";
import type { IndexPayload } from "../../src/addons/drives/types.ts";
import { startAgent } from "../lib/agent.mts";
import { collectWindows } from "./collect.mts";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const mock = process.argv.includes("--mock");
const ready: IndexPayload = {
  state: "running",
  progress: 0.62,
  strategy: "walk",
  message: "Обход папок: нет прав администратора, MFT и USN недоступны.",
};

startAgent({
  port: Number(arg("--port", "4372")),
  hostId: arg("--host-id", "windows-pc"),
  hostName: arg("--name", "Windows PC"),
  os: "win32",
  mockIndex: mock ? ready : null,
  collect: mock
    ? async () => ({
        elevated: false,
        note: "Демо-агент Windows, без железа.",
        volumes: [
          {
            serial: MOCK_GAMES.serial,
            volumeUuid: MOCK_GAMES.volumeUuid,
            filesystem: MOCK_GAMES.filesystem,
            volumeName: MOCK_GAMES.volumeName,
            mountPaths: ["D:\\"],
            totalBytes: MOCK_GAMES.totalBytes,
            freeBytes: MOCK_GAMES.freeBytes,
            busy: false,
            letter: "D",
          },
        ],
      })
    : collectWindows,
});
