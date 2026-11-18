import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { startAgent } from "../../../agents/lib/agent.mts";
import { executeIndexPlan } from "@/addons/drives/execute-index";
import type { VolumeWatchEvent } from "@/addons/drives/index-mode";
import { pollAgent } from "@/addons/drives/agent-client";
import { buildMockCatalog } from "@/addons/drives/mock-source";

vi.mock("@/addons/drives/execute-index", () => ({ executeIndexPlan: vi.fn() }));
const savedSnapshot = process.env.SKLAD_AGENT_SNAPSHOT;
const savedDisabled = process.env.SKLAD_AGENT_DISABLED;
const savedExclude = process.env.SKLAD_EXCLUDE_LETTERS;
afterEach(() => {
  if (savedSnapshot === undefined) delete process.env.SKLAD_AGENT_SNAPSHOT;
  else process.env.SKLAD_AGENT_SNAPSHOT = savedSnapshot;
  if (savedDisabled === undefined) delete process.env.SKLAD_AGENT_DISABLED;
  else process.env.SKLAD_AGENT_DISABLED = savedDisabled;
  if (savedExclude === undefined) delete process.env.SKLAD_EXCLUDE_LETTERS;
  else process.env.SKLAD_EXCLUDE_LETTERS = savedExclude;
  vi.clearAllMocks();
});
const volume = { serial: "test", volumeUuid: "abc", filesystem: "NTFS", volumeName: "test", mountPaths: ["C:\\"], totalBytes: 100, freeBytes: 10, busy: false, letter: "C" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopAgent(server: Server) {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await vi.waitFor(() => expect(server.listening).toBe(false));
}

async function removeAgentDir(directory: string) {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code !== "ENOTEMPTY") throw error;
      await sleep(20);
    }
  }
  throw last;
}

async function stopAndRemove(server: Server, directory: string) {
  await stopAgent(server);
  await removeAgentDir(directory);
}

it("retains an in-flight volume across collection ticks, publishes pages, and never expires a ready tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-test-"));
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  let finish!: (value: Awaited<ReturnType<typeof executeIndexPlan>>) => void;
  vi.mocked(executeIndexPlan).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as ReturnType<typeof executeIndexPlan>);
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }] }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 10 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    await sleep(60); // Multiple collects while the scan owns the original object.
    finish({ called: ["readMft"], payload: { state: "complete", progress: 1, files: [{ relativePath: "RimWorld/a.txt", name: "a.txt", kind: "file", size: 1, mtimeMs: 0 }] } });
    await sleep(90);
    const metadata = await (await fetch(`${base}/v1/volumes?metadata=1`)).json();
    const index = metadata.volumes[0].index;
    expect(index.state).toBe("complete");
    expect(index.recordCount).toBe(1);
    expect(index.files).toBeUndefined();
    expect(executeIndexPlan).toHaveBeenCalledOnce();
    const page = await (await fetch(`${base}/v1/files?serial=test&uuid=abc&revision=${index.revision}&offset=0&limit=1`)).json();
    expect(page.files[0].name).toBe("a.txt");
    expect((await fetch(`${base}/v1/files?serial=test&uuid=abc&revision=old`)).status).toBe(409);
  } finally { await stopAndRemove(server, directory); }
});

it("rebuilds a saved NTFS snapshot once when every file size is zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-sizes-"));
  const snapshotPath = path.join(directory, "snapshot.gz");
  process.env.SKLAD_AGENT_SNAPSHOT = snapshotPath;
  await writeFile(snapshotPath, gzipSync(JSON.stringify({
    volumes: [{
      ...volume,
      index: {
        state: "complete",
        progress: 1,
        strategy: "mft-usn",
        revision: "old-zero",
        files: [{ relativePath: "Windows/notepad.exe", name: "notepad.exe", kind: "file", size: 0, mtimeMs: 0 }],
      },
      indexedAt: Date.now(),
      usnStart: null,
      freeAtIndex: volume.freeBytes,
    }],
  })));
  let finish!: (value: Awaited<ReturnType<typeof executeIndexPlan>>) => void;
  vi.mocked(executeIndexPlan).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as ReturnType<typeof executeIndexPlan>);
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }] }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 10 });
  await once(server, "listening");
  try {
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    finish({
      called: ["readMft"],
      payload: {
        state: "complete",
        progress: 1,
        strategy: "mft-usn",
        files: [{ relativePath: "Windows/notepad.exe", name: "notepad.exe", kind: "file", size: 280_000, mtimeMs: 0 }],
      },
    });
    await sleep(120);
    expect(executeIndexPlan).toHaveBeenCalledOnce();
    const metadata = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/volumes?metadata=1`)).json();
    expect(metadata.volumes[0].index.recordCount).toBe(1);
    expect(metadata.volumes[0].index.state).toBe("complete");
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("does not list or index Z even when config calls it manual-only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-manual-"));
  const disabledPath = path.join(directory, "disabled.json");
  await writeFile(disabledPath, JSON.stringify({ letters: ["Z"], exclude: [] }));
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  process.env.SKLAD_AGENT_DISABLED = disabledPath;
  vi.mocked(executeIndexPlan).mockResolvedValue({
    called: ["walk"],
    payload: { state: "complete", progress: 1, files: [{ relativePath: "Windows/a.txt", name: "a.txt", kind: "file", size: 4, mtimeMs: 0 }] },
  });
  const zee = { ...volume, serial: "WRA04CK7", volumeUuid: "d5625324-d816-4af6-9504-66b4639e2309", volumeName: "Data", mountPaths: ["Z:\\"], letter: "Z", totalBytes: 4_000_000_000_000 };
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }, zee] }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 60_000 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    await sleep(80);
    expect(executeIndexPlan).toHaveBeenCalledOnce();
    const body = await (await fetch(`${base}/v1/volumes?metadata=1`)).json();
    expect(body.volumes.map((item: { letter?: string }) => item.letter)).toEqual(["C"]);
    const rescan = await fetch(`${base}/v1/rescan?serial=${zee.serial}&uuid=${zee.volumeUuid}`, { method: "POST" });
    expect(rescan.status).toBe(404);
    expect(executeIndexPlan).toHaveBeenCalledOnce();
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("pauses a running index on restart and resumes from the MFT cursor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-resume-"));
  const snapshot = path.join(directory, "snapshot.gz");
  process.env.SKLAD_AGENT_SNAPSHOT = snapshot;
  const published = { relativePath: "keep/a.txt", name: "a.txt", kind: "file" as const, size: 8, mtimeMs: 0 };
  await writeFile(snapshot, gzipSync(JSON.stringify({
    volumes: [{
      ...volume,
      index: {
        state: "running",
        progress: 0.4,
        strategy: "mft-usn",
        files: [published],
        checkpoint: { recordsDone: 3, recordsTotal: 10, mftOffset: 4096, nextUsn: "15" },
      },
      usnStart: "15",
      partialFiles: [published],
    }],
  })));
  vi.mocked(executeIndexPlan).mockResolvedValue({
    called: ["readMft"],
    payload: { state: "complete", progress: 1, strategy: "mft-usn", files: [{ relativePath: "keep/b.txt", name: "b.txt", kind: "file", size: 9, mtimeMs: 0 }] },
  });
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }] }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 60_000 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    await sleep(80);
    expect(executeIndexPlan).not.toHaveBeenCalled();
    const listed = await (await fetch(`${base}/v1/volumes?metadata=1`)).json();
    expect(listed.volumes[0].index).toMatchObject({
      state: "paused",
      pauseReason: "restart",
      checkpoint: { recordsDone: 3, nextUsn: "15" },
    });
    const resume = await fetch(`${base}/v1/index/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", serial: volume.serial, uuid: volume.volumeUuid }),
    });
    expect(resume.status).toBe(202);
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    const plan = vi.mocked(executeIndexPlan).mock.calls[0]?.[0];
    expect(plan?.cursor?.recordsDone).toBe(3);
    expect(plan?.cursor?.nextUsn).toBe("15");
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("drops excluded Z before resume and does not index C/D/E/F/S again when their snapshots are ready", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-exclude-"));
  const disabledPath = path.join(directory, "disabled.json");
  await writeFile(disabledPath, JSON.stringify({
    letters: [],
    exclude: ["Z"],
    known: [{ letter: "Z", serial: "WRA04CK7", volumeUuid: "d5625324-d816-4af6-9504-66b4639e2309" }],
  }));
  process.env.SKLAD_AGENT_DISABLED = disabledPath;
  const readyIndex = {
    state: "complete",
    progress: 1,
    strategy: "mft-usn",
    revision: "ready",
    files: [{ relativePath: "keep/a.txt", name: "a.txt", kind: "file", size: 8, mtimeMs: 0 }],
  };
  const disk = (letter: string, serial: string) => ({
    serial,
    volumeUuid: `00000000-0000-4000-8000-00000000000${letter.charCodeAt(0) % 10}`,
    filesystem: "NTFS",
    volumeName: letter,
    mountPaths: [`${letter}:\\`],
    totalBytes: 100,
    freeBytes: 10,
    busy: false,
    letter,
    indexedAt: Date.now(),
    usnStart: null,
    freeAtIndex: 10,
    index: { ...readyIndex, revision: `ready-${letter}` },
  });
  const zee = {
    ...disk("Z", "WRA04CK7"),
    volumeUuid: "d5625324-d816-4af6-9504-66b4639e2309",
    index: { ...readyIndex, state: "running", revision: "z-running", progress: 0.4 },
  };
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  await writeFile(process.env.SKLAD_AGENT_SNAPSHOT, gzipSync(JSON.stringify({
    volumes: [disk("C", "C-SERIAL"), disk("D", "D-SERIAL"), disk("E", "E-SERIAL"), disk("F", "F-SERIAL"), disk("S", "S-SERIAL"), zee],
  })));
  vi.mocked(executeIndexPlan).mockResolvedValue({ called: ["readMft"], payload: { state: "complete", progress: 1, files: [] } });
  const collect = vi.fn(async () => ({
    elevated: true,
    note: "",
    volumes: ["C", "D", "E", "F", "S", "Z"].map((letter) => {
      const source = letter === "Z" ? zee : disk(letter, `${letter}-SERIAL`);
      return {
        serial: source.serial,
        volumeUuid: source.volumeUuid,
        filesystem: source.filesystem,
        volumeName: source.volumeName,
        mountPaths: source.mountPaths,
        totalBytes: source.totalBytes,
        freeBytes: source.freeBytes,
        busy: source.busy,
        letter: source.letter,
      };
    }),
  }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 60_000 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    await sleep(80);
    expect(executeIndexPlan).not.toHaveBeenCalled();
    const body = await (await fetch(`${base}/v1/volumes?metadata=1`)).json();
    expect(body.volumes.map((item: { letter?: string }) => item.letter).sort()).toEqual(["C", "D", "E", "F", "S"]);
    const rescan = await fetch(`${base}/v1/rescan?serial=WRA04CK7&uuid=d5625324-d816-4af6-9504-66b4639e2309`, { method: "POST" });
    expect(rescan.status).toBe(404);
    const stat = await fetch(`${base}/v1/file/stat?serial=WRA04CK7&uuid=d5625324-d816-4af6-9504-66b4639e2309&path=keep/a.txt`);
    expect(stat.status).toBe(404);
    const files = await fetch(`${base}/v1/files?serial=WRA04CK7&uuid=d5625324-d816-4af6-9504-66b4639e2309&revision=z-running`);
    expect(files.status).toBe(404);
    expect(executeIndexPlan).not.toHaveBeenCalled();
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("keeps manual-only D listed and rescannable while Z stays excluded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-manual-d-"));
  const disabledPath = path.join(directory, "disabled.json");
  await writeFile(disabledPath, JSON.stringify({
    letters: ["D"],
    exclude: ["Z"],
    known: [{ letter: "Z", serial: "WRA04CK7", volumeUuid: "d5625324-d816-4af6-9504-66b4639e2309" }],
  }));
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  process.env.SKLAD_AGENT_DISABLED = disabledPath;
  vi.mocked(executeIndexPlan).mockResolvedValue({
    called: ["readMft"],
    payload: { state: "complete", progress: 1, strategy: "mft-usn", files: [{ relativePath: "keep/a.txt", name: "a.txt", kind: "file", size: 8, mtimeMs: 0 }] },
  });
  const disk = (letter: string) => ({
    serial: `${letter}-SERIAL`,
    volumeUuid: `11111111-1111-4111-8111-11111111111${letter.charCodeAt(0) % 10}`,
    filesystem: "NTFS",
    volumeName: letter,
    mountPaths: [`${letter}:\\`],
    totalBytes: 100,
    freeBytes: 10,
    busy: false,
    letter,
  });
  const collect = vi.fn(async () => ({
    elevated: true,
    note: "",
    volumes: [disk("C"), disk("D"), { ...disk("Z"), serial: "WRA04CK7", volumeUuid: "d5625324-d816-4af6-9504-66b4639e2309" }],
  }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 60_000 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    const body = await (await fetch(`${base}/v1/volumes?metadata=1`)).json();
    const letters = body.volumes.map((item: { letter?: string }) => item.letter).sort();
    expect(letters).toEqual(["C", "D"]);
    expect(body.volumes.find((item: { letter?: string }) => item.letter === "D")).toMatchObject({ manualOnly: true, index: null });
    const dee = disk("D");
    const rescan = await fetch(`${base}/v1/rescan?serial=${dee.serial}&uuid=${dee.volumeUuid}`, { method: "POST" });
    expect(rescan.status).toBe(202);
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledTimes(2));
    const blocked = await fetch(`${base}/v1/rescan?serial=WRA04CK7&uuid=d5625324-d816-4af6-9504-66b4639e2309`, { method: "POST" });
    expect(blocked.status).toBe(404);
    expect(executeIndexPlan).toHaveBeenCalledTimes(2);
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("does not launch compact.exe when the process is not Windows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-compact-"));
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  vi.mocked(executeIndexPlan).mockResolvedValue({ called: [], payload: { state: "complete", progress: 1, files: [] } });
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }] }));
  const server = startAgent({ port: 0, hostId: "test", hostName: "test", os: "win32", collect, intervalMs: 60_000 });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    const calls = vi.mocked(executeIndexPlan).mock.calls.length;
    const response = await fetch(`${base}/v1/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, serial: "test", uuid: "abc", path: "Games/Control", algorithm: "LZX" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Сжатие Windows/) });
    expect(vi.mocked(executeIndexPlan).mock.calls.length).toBe(calls);
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("does not collect volumes again on a timer and catches up USN without a second MFT", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-usn-"));
  process.env.SKLAD_AGENT_SNAPSHOT = path.join(directory, "snapshot.gz");
  await writeFile(process.env.SKLAD_AGENT_SNAPSHOT, gzipSync(JSON.stringify({
    volumes: [{
      ...volume,
      usnStart: "15",
      lastEventId: null,
      index: {
        state: "complete",
        progress: 1,
        strategy: "mft-usn",
        files: [{ relativePath: "keep/a.txt", name: "a.txt", kind: "file", size: 8, mtimeMs: 0 }],
      },
    }],
  })));
  vi.mocked(executeIndexPlan).mockResolvedValue({
    called: ["readUsn"],
    payload: {
      state: "complete",
      progress: 1,
      strategy: "mft-usn",
      delta: { upserts: [], deletes: [], complete: true },
    },
  });
  const collect = vi.fn(async () => ({ elevated: true, note: "", volumes: [{ ...volume }] }));
  let emit: (event: VolumeWatchEvent) => void = () => undefined;
  const server = startAgent({
    port: 0,
    hostId: "test",
    hostName: "test",
    os: "win32",
    collect,
    intervalMs: 10,
    watch: { start(on) { emit = on; }, stop() {} },
  });
  await once(server, "listening");
  try {
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledOnce());
    expect(vi.mocked(executeIndexPlan).mock.calls[0]?.[0]).toMatchObject({ incremental: "usn" });
    await sleep(40);
    expect(collect).toHaveBeenCalledOnce();
    expect(executeIndexPlan).toHaveBeenCalledOnce();
    emit({ type: "journal", serial: volume.serial, volumeUuid: volume.volumeUuid, cursor: "16" });
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledTimes(2));
    expect(vi.mocked(executeIndexPlan).mock.calls[1]?.[0]).toMatchObject({ incremental: "usn" });
  } finally {
    await stopAndRemove(server, directory);
  }
});

it("client uses matching revisions without downloading or reapplying their tree", async () => {
  const disk = buildMockCatalog([])[0];
  disk.indexRevision = "same";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ hostId: "test", os: "win32", volumes: [{ serial: disk.serial, volumeUuid: `\\\\?\\Volume{${disk.volumeUuid}}\\`, index: { state: "complete", progress: 1, revision: "same", recordCount: disk.files.length } }] })));
  try {
    const result = await pollAgent({ id: "test", name: "test", os: "win32", url: "http://127.0.0.1:1" }, [disk]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("metadata=1");
    expect(result.volumes[0].index?.files).toBeUndefined();
    expect(result.volumes[0].index?.revision).toBe("same");
  } finally { fetchMock.mockRestore(); }
});
