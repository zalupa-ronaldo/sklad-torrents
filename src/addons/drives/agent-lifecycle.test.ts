import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { startAgent } from "../../../agents/lib/agent.mts";
import { executeIndexPlan } from "@/addons/drives/execute-index";
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
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await sleep(30); await rm(directory, { recursive: true, force: true }); }
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
  }
});

it("lists a manual-only Z: without starting its index until rescan", async () => {
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
    const listed = body.volumes.find((item: { letter?: string }) => item.letter === "Z");
    expect(listed).toMatchObject({ manualOnly: true, volumeUuid: zee.volumeUuid, totalBytes: zee.totalBytes });
    expect(listed.index).toBeNull();
    const rescan = await fetch(`${base}/v1/rescan?serial=${zee.serial}&uuid=${zee.volumeUuid}`, { method: "POST" });
    expect(rescan.status).toBe(202);
    await vi.waitFor(() => expect(executeIndexPlan).toHaveBeenCalledTimes(2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(30);
    await rm(directory, { recursive: true, force: true });
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
