import { MOCK_BACKUP, MOCK_VAULT } from "../../src/addons/drives/mock-ids.ts";
import type { IndexPayload } from "../../src/addons/drives/types.ts";
import { startAgent } from "../lib/agent.mts";
import { collectMac } from "./collect.mts";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const mock = process.argv.includes("--mock");
const ready: IndexPayload = { state: "complete", progress: 1, strategy: "walk", files: [] };

startAgent({
  port: Number(arg("--port", "4371")),
  hostId: arg("--host-id", "mac-mini"),
  hostName: arg("--name", "Mac mini"),
  os: "darwin",
  mockIndex: mock ? ready : null,
  collect: mock
    ? async () => ({
        elevated: true,
        note: "Демо-агент macOS, без железа.",
        volumes: [
          {
            serial: MOCK_VAULT.serial,
            volumeUuid: MOCK_VAULT.volumeUuid,
            filesystem: MOCK_VAULT.filesystem,
            volumeName: MOCK_VAULT.volumeName,
            mountPaths: ["/Volumes/vault 1"],
            totalBytes: MOCK_VAULT.totalBytes,
            freeBytes: MOCK_VAULT.freeBytes,
            busy: false,
            letter: null,
          },
          {
            serial: MOCK_BACKUP.serial,
            volumeUuid: MOCK_BACKUP.volumeUuid,
            filesystem: MOCK_BACKUP.filesystem,
            volumeName: MOCK_BACKUP.volumeName,
            mountPaths: ["/Volumes/BACKUP"],
            totalBytes: MOCK_BACKUP.totalBytes,
            freeBytes: MOCK_BACKUP.freeBytes,
            busy: false,
            letter: null,
          },
        ],
      })
    : collectMac,
});
