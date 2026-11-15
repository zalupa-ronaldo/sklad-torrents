import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256File, transferToPeer, type TransferFile } from "@/lib/localsend/client";
import { PROTOCOL_VERSION, protocolStatusMessage } from "@/lib/localsend/protocol";
import { startPeerServer } from "@/lib/localsend/server";
import { sha256Hex, treeReader } from "@/lib/integrity/hash";
import {
  clearIntegrityRuntimeForTests,
  enqueueIntegrity,
  getIntegrityJob,
  markTransferDone,
} from "@/lib/integrity/engine";
import { resetIntegrityForTests } from "@/lib/integrity/store";

const dirs: string[] = [];
let previousData: string | undefined;

beforeEach(() => {
  previousData = process.env.SKLAD_DATA_DIR;
});

afterEach(async () => {
  clearIntegrityRuntimeForTests();
  if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousData;
  previousData = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalSend SHA-256 on the emulated LAN", () => {
  it("sends a file and a folder from the PC peer and checks SHA-256 before accepting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sklad-ls-"));
    dirs.push(root);
    const sourceDir = path.join(root, "out");
    const receiveDir = path.join(root, "in");
    await mkdir(path.join(sourceDir, "album"), { recursive: true });
    await writeFile(path.join(sourceDir, "notes.txt"), "hello-mac");
    await writeFile(path.join(sourceDir, "album", "track.flac"), "audio-bytes");

    const server = await startPeerServer({
      host: "127.0.0.1",
      port: 0,
      alias: "DESKTOP-OLT9HAV",
      destination: async () => ({
        writeRoot: receiveDir,
        catalogRoot: "D:\\Incoming",
        os: "win32",
        filesystem: "ntfs",
        diskId: "disk-d",
        hostId: "pc-agent",
      }),
    });
    const progress: { name: string; sent: number; size: number }[] = [];
    try {
      const files = await transferFiles(sourceDir, ["notes.txt", path.join("album", "track.flac")]);
      const sent = await transferToPeer({
        peer: { address: "127.0.0.1", port: server.port, protocol: "http", fingerprint: server.fingerprint },
        sender: { alias: "mac-local", version: PROTOCOL_VERSION, fingerprint: "a".repeat(64), deviceType: "desktop" },
        files,
        onProgress: (file, sentBytes) => {
          progress.push({ name: file.fileName, sent: sentBytes, size: file.size });
        },
      });
      expect(sent.ok).toBe(true);
      expect(sent.status).toBe(200);
      expect(progress.some((row) => row.name === "notes.txt" && row.sent === row.size)).toBe(true);
      const savedNote = await readFile(path.join(receiveDir, "notes.txt"));
      const savedTrack = await readFile(path.join(receiveDir, "album", "track.flac"));
      expect(savedNote.toString("utf8")).toBe("hello-mac");
      expect(savedTrack.toString("utf8")).toBe("audio-bytes");
      expect(await sha256File(path.join(receiveDir, "notes.txt"))).toBe(files[0]?.sha256);
      expect(await readFile(path.join(sourceDir, "notes.txt"), "utf8")).toBe("hello-mac");

      const broken = await transferToPeer({
        peer: { address: "127.0.0.1", port: server.port, protocol: "http", fingerprint: server.fingerprint },
        sender: { alias: "mac-local", version: PROTOCOL_VERSION, fingerprint: "b".repeat(64) },
        files: [{ ...files[0]!, id: "bad", sha256: "0".repeat(64) }],
      });
      expect(broken.ok).toBe(false);
      if (broken.ok) throw new Error("битый SHA-256 не должен приниматься");
      expect(broken.status).toBe(422);
      expect(broken.message).toContain(protocolStatusMessage(422));
      expect(server.completedUploads).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("keeps the LocalSend hash uncompared until the transfer is finished", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-ls-hash-"));
    dirs.push(dir);
    process.env.SKLAD_DATA_DIR = dir;
    clearIntegrityRuntimeForTests();
    await resetIntegrityForTests();
    const bytes = new TextEncoder().encode("localsend");
    const queued = await enqueueIntegrity({
      kind: "localsend",
      title: "LocalSend",
      transferDone: false,
      source: treeReader({ "notes.txt": bytes }),
      destination: treeReader({ "notes.txt": bytes }),
    });
    const pending = await waitHash(queued.id);
    expect(pending.files.every((file) => file.sha256 === sha256Hex(bytes))).toBe(true);
    expect(pending.files.some((file) => file.status === "match")).toBe(false);
    expect(pending.deleteAllowed).toBe(false);
    await markTransferDone(queued.id);
    const done = await waitHash(queued.id);
    expect(done.transferDone).toBe(true);
    expect(done.files.every((file) => file.status === "match")).toBe(true);
    expect(done.deleteAllowed).toBe(false);
  });
});

async function transferFiles(root: string, names: string[]): Promise<TransferFile[]> {
  const files: TransferFile[] = [];
  for (const name of names) {
    const full = path.join(root, name);
    const data = await readFile(full);
    files.push({
      id: name.replace(/[\\/]/g, "-"),
      fileName: name.split(path.sep).join("/"),
      size: data.byteLength,
      fileType: "application/octet-stream",
      sha256: await sha256File(full),
      path: full,
    });
  }
  return files;
}

async function waitHash(id: string) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const job = await getIntegrityJob(id);
    if (job && (job.state === "done" || job.state === "error")) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`hash job ${id} did not finish`);
}
