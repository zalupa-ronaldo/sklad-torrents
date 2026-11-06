import { mkdtemp, rm } from "node:fs/promises";
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
afterEach(() => { if (savedSnapshot === undefined) delete process.env.SKLAD_AGENT_SNAPSHOT; else process.env.SKLAD_AGENT_SNAPSHOT = savedSnapshot; vi.clearAllMocks(); });
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
