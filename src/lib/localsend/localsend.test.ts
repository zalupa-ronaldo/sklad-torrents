import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCatalog } from "@/addons/drives/store";
import type { DiskRecord, IndexedFile } from "@/addons/drives/types";
import { setAppDataDir } from "@/lib/app-data";
import { searchCatalog, acceptReceivedFiles } from "@/lib/drive/catalog";
import { enqueueJob, getJob, listJobs, registerJobHandler, whenJobsIdle } from "@/lib/jobs/queue";
import type { JobRecord, JobState } from "@/lib/jobs/types";
import { protocolRequest, transferToPeer } from "@/lib/localsend/client";
import { upsertDevice } from "@/lib/localsend/discovery";
import { PROTOCOL_VERSION } from "@/lib/localsend/protocol";
import { startPeerServer, type PeerServer } from "@/lib/localsend/server";
import { enqueueSend } from "@/lib/localsend/service";
import { saveSettings } from "@/lib/localsend/settings";
import { listTransfers } from "@/lib/localsend/view";

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
    const sourcePath = path.join(process.cwd(), "fixtures", "localsend", "sklad-note.txt");
    const bytes = await readFile(sourcePath);
    expect(server.uploads[0].bytes.equals(bytes)).toBe(true);
    expect(Buffer.compare(await readFile(sourcePath), bytes)).toBe(0);
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
      const { restoreLocalsendAfterRestart } = await import("@/lib/localsend/service");
      const kept = path.join(dataDir, "keep.txt");
      await writeFile(kept, "abc");
      const { insertJob } = await import("@/lib/jobs/queue");
      const send = await insertJob({
        kind: "localsend.send",
        idempotencyKey: "keep-restart",
        title: "send",
        state: "running",
        payload: { files: [{ localPath: kept, sent: true, sha256: "abc" }] },
      });
      await recoverInterruptedJobs();
      expect(await restoreLocalsendAfterRestart()).toBeGreaterThan(0);
      const restored = await getJob(send.id);
      expect(restored?.state).toBe("paused");
      expect(await readFile(kept, "utf8")).toBe("abc");
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

  it("keeps a local folder tree, records SHA-256, and does not delete the originals", async () => {
    const previous = process.env.SKLAD_DATA_DIR;
    process.env.SKLAD_DATA_DIR = dataDir;
    const root = path.join(dataDir, "notes");
    await mkdir(path.join(root, "nested"), { recursive: true });
    const note = Buffer.from("note-a");
    const clip = Buffer.from("clip-b");
    const notePath = path.join(root, "a.txt");
    const clipPath = path.join(root, "nested", "b.txt");
    await writeFile(notePath, note);
    await writeFile(clipPath, clip);
    const server = await track(startPeerServer({ protocol: "http", alias: "Folder peer" }));
    remember(server);
    try {
      await writeCatalog({
        version: 1,
        seeded: true,
        disks: [
          shelfDisk({
            id: "disk-here",
            label: "Здесь",
            filesystem: "ext4",
            pathStyle: "posix",
            lastMountPath: root,
            lastHostId: "local",
            lastHostName: "Склад",
            connectedHosts: [{ id: "local", name: "Склад", os: "darwin", elevated: false, mountPaths: [root] }],
            files: [indexed("a.txt", "a.txt", note.length), indexed("nested/b.txt", "b.txt", clip.length)],
          }),
        ],
      });
      const { job } = await enqueueSend({
        fingerprint: server.fingerprint,
        entryIds: [],
        driveFiles: [{ diskId: "disk-here", path: root, name: "notes", kind: "dir" }],
      });
      const done = await waitJob(job.id, ["done", "error"]);
      expect(done.state).toBe("done");
      const names = Object.values(server.prepares[0].files).map((file) => file.fileName).sort();
      expect(names).toEqual(["notes/a.txt", "notes/nested/b.txt"]);
      const noteHash = createHash("sha256").update(note).digest("hex");
      const clipHash = createHash("sha256").update(clip).digest("hex");
      const byName = new Map(Object.values(server.prepares[0].files).map((file) => [file.fileName, file.sha256]));
      expect(byName.get("notes/a.txt")).toBe(noteHash);
      expect(byName.get("notes/nested/b.txt")).toBe(clipHash);
      expect(await readFile(notePath)).toEqual(note);
      expect(await readFile(clipPath)).toEqual(clip);
      const view = (await listTransfers()).find((item) => item.id === job.id);
      expect(view?.files.every((file) => file.sha256 && file.sha256.length === 64)).toBe(true);
      expect(view?.direction).toBe("send");
    } finally {
      if (previous === undefined) delete process.env.SKLAD_DATA_DIR;
      else process.env.SKLAD_DATA_DIR = previous;
    }
  });

  it("rejects a checksum mismatch and does not leave the incoming file", async () => {
    const inbox = path.join(dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const server = await track(
      startPeerServer({
        protocol: "http",
        alias: "Strict",
        destination: async () => ({
          writeRoot: inbox,
          catalogRoot: inbox,
          os: "linux",
          filesystem: "other",
          diskId: null,
          hostId: "local",
        }),
      }),
    );
    const filePath = path.join(dataDir, "source.txt");
    const bytes = Buffer.from("keep-me");
    await writeFile(filePath, bytes);
    const result = await transferToPeer({
      peer: peerOf(server),
      sender,
      files: [{ ...transferFile("bad", "source.txt", bytes.length, filePath), sha256: "b".repeat(64) }],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(server.completedUploads).toBe(0);
    expect(await readdir(inbox)).toEqual([]);
    expect(await readFile(filePath)).toEqual(bytes);
  });

  it("receives a folder, reports cumulative progress, and stores each SHA-256", async () => {
    const inbox = path.join(dataDir, "folder-inbox");
    const progress: { sessionBytes: number; sessionTotal: number }[] = [];
    const accepted: string[] = [];
    const server = await track(
      startPeerServer({
        protocol: "http",
        alias: "Folder inbox",
        destination: async () => ({
          writeRoot: inbox,
          catalogRoot: "/Volumes/vault/Incoming",
          os: "darwin",
          filesystem: "apfs",
          diskId: "disk-mac",
          hostId: "demo-mac",
        }),
        onProgress: async (update) => {
          progress.push({ sessionBytes: update.sessionBytes, sessionTotal: update.sessionTotal });
        },
        onFileAccepted: async (file) => {
          accepted.push(file.sha256);
          await acceptReceivedFiles([file]);
        },
      }),
    );
    const first = Buffer.from("alpha");
    const second = Buffer.from("bravo!");
    const firstPath = path.join(dataDir, "a.txt");
    const secondPath = path.join(dataDir, "b.txt");
    await writeFile(firstPath, first);
    await writeFile(secondPath, second);
    const firstHash = createHash("sha256").update(first).digest("hex");
    const secondHash = createHash("sha256").update(second).digest("hex");
    const result = await transferToPeer({
      peer: peerOf(server),
      sender,
      files: [
        { ...transferFile("a", "Pack/a.txt", first.length, firstPath), sha256: firstHash },
        { ...transferFile("b", "Pack/nested/b.txt", second.length, secondPath), sha256: secondHash },
      ],
    });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(inbox, "Pack", "a.txt"))).toEqual(first);
    expect(await readFile(path.join(inbox, "Pack", "nested", "b.txt"))).toEqual(second);
    expect(accepted.sort()).toEqual([firstHash, secondHash].sort());
    expect(progress.at(-1)).toEqual({ sessionBytes: first.length + second.length, sessionTotal: first.length + second.length });
    expect(progress.every((item) => item.sessionTotal === first.length + second.length)).toBe(true);
    expect(await readFile(firstPath)).toEqual(first);
  });
});

describe("LocalSend from Mac and PC", () => {
  let previousData: string | undefined;

  beforeEach(() => {
    previousData = process.env.SKLAD_DATA_DIR;
    process.env.SKLAD_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
    else process.env.SKLAD_DATA_DIR = previousData;
  });

  it("streams a file from the PC agent and leaves the source in place", async () => {
    const bytes = Buffer.from("from-the-pc");
    const agent = await mockAgent({ "Games/note.txt": bytes });
    const server = await track(startPeerServer({ protocol: "http", alias: "Phone" }));
    remember(server);
    try {
      await writeAgents(agent.port);
      await writeCatalog({
        version: 1,
        seeded: true,
        disks: [
          shelfDisk({
            id: "disk-pc",
            label: "Games",
            pathStyle: "win32",
            lastMountPath: "S:\\",
            lastHostId: "windows-pc",
            lastHostName: "Windows PC",
            connectedHosts: [{ id: "windows-pc", name: "Windows PC", os: "win32", elevated: true, mountPaths: ["S:\\"] }],
            files: [indexed("Games/note.txt", "note.txt", bytes.length)],
          }),
        ],
      });
      const { job } = await enqueueSend({
        fingerprint: server.fingerprint,
        entryIds: [],
        driveFiles: [{ diskId: "disk-pc", path: "S:\\Games\\note.txt", name: "note.txt", kind: "file" }],
      });
      const done = await waitJob(job.id, ["done", "error"]);
      expect(done.state).toBe("done");
      expect(done.error).toBeNull();
      expect(server.uploads[0].bytes.equals(bytes)).toBe(true);
      const sent = Object.values(server.prepares[0].files)[0];
      expect(sent.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      const payload = done.payload as { hostLabel: string; files: { sha256: string; hostLabel: string }[] };
      expect(payload.hostLabel).toBe("ПК");
      expect(payload.files[0].sha256).toBe(sent.sha256);
      expect(payload.files[0].hostLabel).toBe("ПК");
      const again = await fetch(`http://127.0.0.1:${agent.port}/v1/file/content?serial=SN&uuid=uuid&path=Games/note.txt`);
      expect(Buffer.from(await again.arrayBuffer())).toEqual(bytes);
    } finally {
      await agent.close();
    }
  });

  it("sends a Mac folder through the agent with relative names", async () => {
    const photo = Buffer.from("photo");
    const raw = Buffer.from("raw-data");
    const agent = await mockAgent({
      "Photos/trip/a.jpg": photo,
      "Photos/trip/raw/b.dng": raw,
    });
    const server = await track(startPeerServer({ protocol: "http", alias: "Tablet" }));
    remember(server);
    try {
      await writeAgents(agent.port);
      await writeCatalog({
        version: 1,
        seeded: true,
        disks: [
          shelfDisk({
            id: "disk-mac-live",
            label: "Vault",
            filesystem: "APFS",
            pathStyle: "posix",
            lastMountPath: "/Volumes/vault",
            lastHostId: "mac-mini",
            lastHostName: "Mac mini",
            connectedHosts: [{ id: "mac-mini", name: "Mac mini", os: "darwin", elevated: true, mountPaths: ["/Volumes/vault"] }],
            files: [
              indexed("Photos/trip/a.jpg", "a.jpg", photo.length),
              indexed("Photos/trip/raw/b.dng", "b.dng", raw.length),
            ],
          }),
        ],
      });
      const { job } = await enqueueSend({
        fingerprint: server.fingerprint,
        entryIds: [],
        driveFiles: [{ diskId: "disk-mac-live", path: "/Volumes/vault/Photos/trip", name: "trip", kind: "dir" }],
      });
      const done = await waitJob(job.id, ["done", "error"]);
      expect(done.state).toBe("done");
      const names = Object.values(server.prepares[0].files).map((file) => file.fileName).sort();
      expect(names).toEqual(["trip/a.jpg", "trip/raw/b.dng"]);
      const payload = done.payload as { hostLabel: string };
      expect(payload.hostLabel).toBe("Mac");
      const bodies = server.uploads.map((upload) => upload.bytes.toString("utf8")).sort();
      expect(bodies).toEqual(["photo", "raw-data"]);
    } finally {
      await agent.close();
    }
  });

  it("refuses Z: before any agent read", async () => {
    const agent = await mockAgent({ "secret.bin": Buffer.from("nope") });
    const server = await track(startPeerServer({ protocol: "http", alias: "Nowhere" }));
    remember(server);
    try {
      await writeAgents(agent.port);
      await writeCatalog({
        version: 1,
        seeded: true,
        disks: [
          shelfDisk({
            id: "disk-z",
            label: "Hidden",
            lastMountPath: "Z:\\",
            lastHostId: "windows-pc",
            lastHostName: "Windows PC",
            pathStyle: "win32",
            connectedHosts: [{ id: "windows-pc", name: "Windows PC", os: "win32", elevated: true, mountPaths: ["Z:\\"] }],
            files: [indexed("secret.bin", "secret.bin", 4)],
          }),
        ],
      });
      await expect(
        enqueueSend({
          fingerprint: server.fingerprint,
          entryIds: [],
          driveFiles: [{ diskId: "disk-z", path: "Z:\\secret.bin", name: "secret.bin", kind: "file" }],
        }),
      ).rejects.toThrow(/Z:/);
      expect(agent.hits()).toBe(0);
      expect((await listJobs()).some((job) => job.kind === "localsend.send")).toBe(false);
    } finally {
      await agent.close();
    }
  });
});

describe("LocalSend settings", () => {
  it("does not accept Z: as the receive folder", async () => {
    await expect(
      saveSettings({
        alias: "Склад",
        receivePin: "",
        destination: { mode: "path", os: "win32", path: "Z:\\Incoming" },
      }),
    ).rejects.toThrow(/Z:/);
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

function indexed(relativePath: string, name: string, size: number): IndexedFile {
  return { relativePath, name, kind: "file", size, mtimeMs: 1, sidecarCategory: null, categories: [] };
}

function shelfDisk(partial: Partial<DiskRecord> & { files: IndexedFile[] }): DiskRecord {
  return {
    id: partial.id || "disk",
    serial: "SN",
    serialNorm: "sn",
    volumeUuid: "uuid",
    uuidNorm: "uuid",
    filesystem: partial.filesystem || "NTFS",
    label: partial.label || "Disk",
    namedByUser: false,
    volumeName: partial.label || "Disk",
    totalBytes: 1_000_000,
    freeBytes: 500_000,
    lastSeenAt: "2026-11-15T00:00:00.000Z",
    lastHostId: partial.lastHostId || "windows-pc",
    lastHostName: partial.lastHostName || "Windows PC",
    pathStyle: partial.pathStyle || "win32",
    lastMountPath: partial.lastMountPath || "S:\\",
    priorMountPath: "",
    connectedHosts: partial.connectedHosts || [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "walk", progress: 1, message: "", elevated: true },
    files: partial.files,
  };
}

async function writeAgents(port: number): Promise<void> {
  const agents = [
    { id: "windows-pc", name: "Windows PC", os: "win32", url: `http://127.0.0.1:${port}` },
    { id: "mac-mini", name: "Mac mini", os: "darwin", url: `http://127.0.0.1:${port}` },
  ];
  await writeFile(path.join(dataDir, "drive-agents.json"), JSON.stringify({ mode: "agents", agents }));
}

function mockAgent(files: Record<string, Buffer>): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = files[url.searchParams.get("path") || ""];
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Файл не найден на томе." }));
      return;
    }
    if (url.pathname === "/v1/file/stat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, size: body.length }));
      return;
    }
    if (url.pathname === "/v1/file/content") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        hits: () => hits,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}
