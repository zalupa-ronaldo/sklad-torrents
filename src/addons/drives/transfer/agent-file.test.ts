import { createServer } from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { startAgent } from "../../../../agents/lib/agent.mts";

const root = path.join(process.cwd(), ".tmp-transfer-agent");
const filePath = path.join(root, "hello.bin");
const payload = Buffer.from("sklad-transfer-bytes-32!!!!!!!!!!!!"); // 32 bytes

describe("agent file content", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  const serial = "TESTSERIAL";
  const uuid = "11111111-2222-3333-4444-555555555555";

  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFile(filePath, payload);
    server = startAgent({
      port: 0,
      hostId: "test-host",
      hostName: "Test",
      os: "darwin",
      intervalMs: 60_000,
      collect: async () => ({
        elevated: true,
        note: "",
        volumes: [
          {
            serial,
            volumeUuid: uuid,
            filesystem: "APFS",
            volumeName: "tmp",
            mountPaths: [root],
            totalBytes: 1_000_000,
            freeBytes: 500_000,
            busy: false,
            letter: null,
          },
        ],
      }),
      mockIndex: { state: "complete", progress: 1, strategy: "walk", files: [] },
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
    // wait one collect tick
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/v1/volumes?metadata=1`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("streams file bytes and rejects path escape", async () => {
    const bad = await fetch(`${base}/v1/file/content?serial=${serial}&uuid=${uuid}&path=../hello.bin`);
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/v1/file/content?serial=${serial}&uuid=${uuid}&path=hello.bin`);
    expect(ok.status).toBe(200);
    const buf = Buffer.from(await ok.arrayBuffer());
    expect(buf.equals(payload)).toBe(true);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  it("writes with checksum verify", async () => {
    const body = Buffer.from("written-by-test-agent-put");
    const put = await fetch(`${base}/v1/file/content?serial=${serial}&uuid=${uuid}&path=out/note.txt`, {
      method: "PUT",
      body,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(put.status).toBe(200);
    const json = (await put.json()) as { sha256: string; bytes: number };
    expect(json.bytes).toBe(body.length);
    expect(json.sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("blocks Z letter volumes", async () => {
    // no Z in this agent; escape absolute rejected
    const abs = await fetch(`${base}/v1/file/content?serial=${serial}&uuid=${uuid}&path=/etc/passwd`);
    expect(abs.status).toBe(400);
  });
});
