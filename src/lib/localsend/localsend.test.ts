import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAppDataDir } from "@/lib/app-data";
import { searchCatalog, acceptReceivedFiles } from "@/lib/drive/catalog";
import { enqueueJob, getJob, listJobs, registerJobHandler, whenJobsIdle } from "@/lib/jobs/queue";
import type { JobRecord, JobState } from "@/lib/jobs/types";
import { protocolRequest, transferToPeer } from "@/lib/localsend/client";
import { upsertDevice } from "@/lib/localsend/discovery";
import { PROTOCOL_VERSION } from "@/lib/localsend/protocol";
import { startPeerServer, type PeerServer } from "@/lib/localsend/server";
import { enqueueSend } from "@/lib/localsend/service";

const sender = {
  alias: "Склад",
  version: PROTOCOL_VERSION,
  deviceModel: "Склад",
  deviceType: "desktop",
  fingerprint: "sklad-sender",
  port: 53317,
  protocol: "http" as const,
  download: false,
};

let dataDir = "";
const servers: PeerServer[] = [];

beforeEach(async () => {
  await whenJobsIdle();
  dataDir = await mkdtemp(path.join(tmpdir(), "sklad-ls-"));
  setAppDataDir(dataDir);
});

afterEach(async () => {
  await whenJobsIdle();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  setAppDataDir(null);
  await rm(dataDir, { recursive: true, force: true });
});

describe("LocalSend protocol", () => {
  it("completes prepare-upload and upload only after HTTP 200s", async () => {
    const server = await track(startPeerServer({ protocol: "http", alias: "Fake Peer" }));
    const filePath = path.join(dataDir, "hello.txt");
    const bytes = Buffer.from("hello localsend");
    await writeFile(filePath, bytes);
    const refused = await startPeerServer({ protocol: "http", alias: "Refuse upload", uploadStatus: 500 });
    servers.push(refused);

    const failed = await transferToPeer({
      peer: peerOf(refused),
      sender,
      files: [transferFile("file-1", "hello.txt", bytes.length, filePath)],
    });
    expect(failed.ok).toBe(false);
    expect(failed.status).not.toBe(200);

    const result = await transferToPeer({
      peer: peerOf(server),
      sender,
      files: [transferFile("file-1", "hello.txt", bytes.length, filePath)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.sessionId).toBeTruthy();
    expect(result.tokens["file-1"]).toBeTruthy();
    expect(server.prepares).toHaveLength(1);
    expect(server.prepares[0].files["file-1"].fileName).toBe("hello.txt");
    expect(server.prepares[0].files["file-1"].size).toBe(bytes.length);
    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0].sessionId).toBe(result.sessionId);
    expect(server.uploads[0].token).toBe(result.tokens["file-1"]);
    expect(server.uploads[0].fileId).toBe("file-1");
    expect(server.uploads[0].bytes.equals(bytes)).toBe(true);
    expect(server.uploads[0].status).toBe(200);
    expect(server.completedUploads).toBe(1);
  });

  it("does not accept a peer whose certificate fingerprint was swapped", async () => {
    const server = await track(startPeerServer({ protocol: "https", alias: "Pinned", certDir: path.join(dataDir, "cert") }));
    const filePath = path.join(dataDir, "pin.txt");
    await writeFile(filePath, "pin");
    const result = await transferToPeer({
      peer: { ...peerOf(server), fingerprint: "a".repeat(64) },
      sender,
      files: [transferFile("file-pin", "pin.txt", 3, filePath)],
    });
    expect(result.ok).toBe(false);
    expect(server.completedUploads).toBe(0);
  });
});

describe("LocalSend jobs", () => {
  it("turns a refused prepare-upload into a job error", async () => {
    const server = await track(startPeerServer({ protocol: "http", alias: "Busy", prepareStatus: 403 }));
    remember(server);
    const { job } = await enqueueSend({ fingerprint: server.fingerprint, entryIds: ["fixture-note"] });
    const finished = await waitJob(job.id, ["error", "done"]);
    expect(finished.state).toBe("error");
    expect(finished.state).not.toBe("done");
    expect(finished.error).toMatch(/403/);
    expect(server.completedUploads).toBe(0);
    expect(server.uploads).toHaveLength(0);
  });

  it("returns the queued job before the upload finishes and deduplicates it", async () => {
    const server = await track(
      startPeerServer({ protocol: "http", alias: "Slow", uploadDelayMs: 1000 }),
    );
    remember(server);
    const started = Date.now();
    const first = await enqueueSend({ fingerprint: server.fingerprint, entryIds: ["fixture-note"] });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.job.state).not.toBe("done");
    expect(server.completedUploads).toBe(0);

    const second = await enqueueSend({ fingerprint: server.fingerprint, entryIds: ["fixture-note"] });
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    const active = (await listJobs()).filter((job) => job.kind === "localsend.send" && job.idempotencyKey === first.job.idempotencyKey);
    expect(active).toHaveLength(1);

    const done = await waitJob(first.job.id, ["done", "error"]);
    expect(done.state).toBe("done");
    expect(done.sessionId).toBeTruthy();
    const bytes = await readFile(path.join(process.cwd(), "fixtures", "localsend", "sklad-note.txt"));
    expect(server.uploads[0].bytes.equals(bytes)).toBe(true);
    expect(server.uploads[0].sessionId).toBe(done.sessionId);
    expect(server.uploads[0].token.length).toBeGreaterThan(8);
    expect(server.prepares[0].info.alias).toBe("Склад");

    const again = await enqueueSend({ fingerprint: server.fingerprint, entryIds: ["fixture-note"] });
    expect(again.duplicate).toBe(false);
    expect(again.job.id).not.toBe(first.job.id);
    await waitJob(again.job.id, ["done", "error"]);
  });

  it("reloads a running job from disk and does not mark an interrupted run as done", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerJobHandler("test.block", async () => {
      await gate;
    });
    try {
      const blocked = await enqueueJob({
        kind: "test.block",
        idempotencyKey: "block-1",
        title: "Держим",
        payload: { n: 1 },
      });
      const running = await waitJob(blocked.job.id, ["running"]);
      expect(running.payload).toEqual({ n: 1 });
      const { recoverInterruptedJobs } = await import("@/lib/jobs/queue");
      await recoverInterruptedJobs();
      const recovered = await getJob(blocked.job.id);
      expect(recovered?.state).toBe("error");
      expect(recovered?.state).not.toBe("done");
      expect(recovered?.error).toMatch(/перезапуск/i);
    } finally {
      release();
      await whenJobsIdle();
    }
  });
});

describe("LocalSend receive", () => {
  it("indexes a received file only after the upload returns HTTP 200", async () => {
    const inbox = path.join(dataDir, "inbox");
    let accepted = 0;
    const server = await track(
      startPeerServer({
        protocol: "http",
        alias: "Inbox",
        destination: async () => ({
          writeRoot: inbox,
          catalogRoot: "/Volumes/vault/Incoming",
          os: "darwin",
          filesystem: "apfs",
          diskId: "disk-mac",
          hostId: "demo-mac",
        }),
        onFileAccepted: async (file) => {
          accepted += 1;
          await acceptReceivedFiles([file]);
        },
      }),
    );
    const filePath = path.join(dataDir, "from-peer.txt");
    const bytes = Buffer.from("received-by-protocol");
    await writeFile(filePath, bytes);
    const peer = peerOf(server);
    const prepare = await protocolRequest({
      peer,
      method: "POST",
      path: "/api/localsend/v2/prepare-upload",
      json: {
        info: sender,
        files: {
          "in-1": {
            id: "in-1",
            fileName: "from-peer.txt",
            size: bytes.length,
            fileType: "text/plain",
          },
        },
      },
    });
    expect(prepare.status).toBe(200);
    expect(accepted).toBe(0);
    expect(await searchCatalog("from-peer.txt")).toHaveLength(0);

    const prepared = JSON.parse(prepare.body.toString("utf8")) as { sessionId: string; files: Record<string, string> };
    const refused = await track(startPeerServer({ protocol: "http", uploadStatus: 500, alias: "No index" }));
    const refusedUpload = await protocolRequest({
      peer: peerOf(refused),
      method: "POST",
      path: "/api/localsend/v2/upload?sessionId=missing&fileId=in-1&token=nope",
      filePath,
    });
    expect(refusedUpload.status).not.toBe(200);
    expect(accepted).toBe(0);

    const upload = await protocolRequest({
      peer,
      method: "POST",
      path: `/api/localsend/v2/upload?${new URLSearchParams({
        sessionId: prepared.sessionId,
        fileId: "in-1",
        token: prepared.files["in-1"],
      }).toString()}`,
      filePath,
    });
    expect(upload.status).toBe(200);
    expect(accepted).toBe(1);
    const found = await searchCatalog("/Volumes/vault/Incoming/from-peer.txt");
    const saved = found.find((entry) => entry.path === "/Volumes/vault/Incoming/from-peer.txt");
    expect(saved).toBeTruthy();
    expect(saved?.filesystem).toBe("apfs");
    expect(saved?.filesystem).not.toBe("ntfs");
    expect(saved?.os).toBe("darwin");
    expect(saved?.policy?.dryRun).toBe(true);
    expect(saved?.policy?.destructive).toBe(false);
    expect(saved?.policy?.action).toBe("none");
    expect(saved?.source).toBe("localsend");
  });
});

function peerOf(server: PeerServer) {
  return {
    address: "127.0.0.1",
    port: server.port,
    protocol: server.protocol,
    fingerprint: server.fingerprint,
  };
}

function remember(server: PeerServer): void {
  upsertDevice({
    alias: server.info.alias,
    address: "127.0.0.1",
    port: server.port,
    protocol: server.protocol,
    fingerprint: server.fingerprint,
    deviceModel: "test",
    deviceType: "headless",
    version: PROTOCOL_VERSION,
    demo: false,
    source: "manual",
    lastSeen: Date.now(),
  });
}

function transferFile(id: string, fileName: string, size: number, filePath: string) {
  return { id, fileName, size, fileType: "text/plain", path: filePath };
}

async function track(pending: Promise<PeerServer>): Promise<PeerServer> {
  const server = await pending;
  servers.push(server);
  return server;
}

async function waitJob(id: string, states: JobState[]): Promise<JobRecord> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const job = await getJob(id);
    if (job && states.includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`задача ${id} не пришла в ${states.join(", ")}`);
}
