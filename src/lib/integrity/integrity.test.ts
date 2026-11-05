import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { manifestDocument, manifestFilename, manifestLine } from "@/lib/integrity/manifest";
import { directoryReader, sha256Hex, treeReader } from "@/lib/integrity/hash";
import {
  cancelIntegrity,
  clearIntegrityRuntimeForTests,
  confirmIntegrityDelete,
  continueIntegrity,
  enqueueIntegrity,
  getIntegrityJob,
  markTransferDone,
  setIntegrityGateForTests,
} from "@/lib/integrity/engine";
import { mutateIntegrity, readIntegrity, resetIntegrityForTests } from "@/lib/integrity/store";
import type { IntegrityJob } from "@/lib/integrity/types";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.SKLAD_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "sklad-hash-"));
  process.env.SKLAD_DATA_DIR = dataDir;
  clearIntegrityRuntimeForTests();
  await resetIntegrityForTests();
});

afterEach(async () => {
  clearIntegrityRuntimeForTests();
  if (previousDataDir === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("SHA-256 integrity", () => {
  it("hashes the known abc vector", () => {
    expect(sha256Hex("abc")).toBe(ABC);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC);
  });

  it("writes sha256sum lines with two spaces", () => {
    expect(manifestLine(ABC, "dir/a.txt")).toBe(`${ABC}  dir/a.txt`);
    expect(manifestDocument([{ sha256: ABC.toUpperCase(), relativePath: "dir/a.txt" }])).toBe(`${ABC}  dir/a.txt\n`);
    expect(manifestFilename("Кино: пример")).toBe("Кино пример.sha256");
  });

  it("returns from enqueue before hashing finishes", async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    setIntegrityGateForTests(hold);
    const queued = await enqueueIntegrity({
      kind: "torrent",
      title: "Раздача",
      source: treeReader({ "a.txt": bytes("abc") }),
      torrent: { hostId: "demo", hash: "a".repeat(40), name: "Раздача" },
    });
    expect(queued.state).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mid = await getIntegrityJob(queued.id);
    expect(mid?.state).not.toBe("done");
    expect(mid?.files.every((file) => file.sha256 === "")).toBe(true);
    release?.();
    const done = await waitJob(queued.id);
    expect(done.files[0]?.sha256).toBe(ABC);
    expect(done.comparable).toBe(false);
  });

  it("matches a move only when every file matches and the user confirms", async () => {
    const same = await runPair("move", { "game/a.txt": bytes("abc"), "game/b.txt": bytes("def") }, {
      "game/a.txt": bytes("abc"),
      "game/b.txt": bytes("def"),
    });
    expect(same.state).toBe("done");
    expect(same.files.every((file) => file.status === "match")).toBe(true);
    expect(same.deleteAllowed).toBe(false);
    const confirmed = await confirmIntegrityDelete(same.id, true);
    expect(confirmed.deleteAllowed).toBe(true);
    const withheld = await confirmIntegrityDelete(same.id, false);
    expect(withheld.deleteAllowed).toBe(false);

    const flipped = bytes("abc");
    flipped[0] ^= 1;
    const broken = await runPair("move", { "game/a.txt": bytes("abc") }, { "game/a.txt": flipped });
    expect(broken.files.some((file) => file.status === "mismatch")).toBe(true);
    expect(broken.mismatchPaths).toContain("game/a.txt");
    const still = await confirmIntegrityDelete(broken.id, true);
    expect(still.deleteAllowed).toBe(false);
    expect(still.deleteReason).toMatch(/game\/a\.txt/);

    const missing = await runPair("copy", { "game/a.txt": bytes("abc") }, {});
    expect(missing.files.some((file) => file.relativePath === "game/a.txt" && file.status === "mismatch")).toBe(true);
    expect((await confirmIntegrityDelete(missing.id, true)).deleteAllowed).toBe(false);
  });

  it("treats compact logical bytes as a comparison and a changed byte as an error", async () => {
    const same = await runPair("compact", { "pack.bin": bytes("abc") }, { "pack.bin": bytes("abc") });
    expect(same.state).toBe("done");
    expect(same.files.every((file) => file.status === "match")).toBe(true);

    const changed = bytes("abc");
    changed[2] ^= 0xff;
    const bad = await runPair("compact", { "pack.bin": bytes("abc") }, { "pack.bin": changed });
    expect(bad.state).toBe("error");
    expect(bad.files.some((file) => file.status === "mismatch")).toBe(true);
    expect(bad.deleteAllowed).toBe(false);
  });

  it("stores handbrake input and output without treating inequality as an error", async () => {
    const job = await runPair("handbrake", { "in.mkv": bytes("abc") }, { "out.mp4": bytes("xyz") }, { comparable: false });
    expect(job.comparable).toBe(false);
    expect(job.state).not.toBe("error");
    expect(job.files.map((file) => file.sha256).sort()).toEqual([sha256Hex("abc"), sha256Hex("xyz")].sort());
    expect(job.files.every((file) => file.status === "recorded")).toBe(true);
    expect(job.deleteAllowed).toBe(false);
    const confirmed = await confirmIntegrityDelete(job.id, true);
    expect(confirmed.deleteAllowed).toBe(false);
  });

  it("stores optical checksums only when the disc read matches", async () => {
    const good = await runPair("optical", { "clip.bin": bytes("abc") }, { "clip.bin": bytes("abc") }, { rewritable: true });
    expect(good.discVerified).toBe(true);
    const saved = await readIntegrity();
    const disc = saved.discs.find((item) => item.jobId === good.id);
    expect(disc?.verified).toBe(true);
    expect(disc?.erased).toBe(false);
    expect(disc?.rewritable).toBe(true);
    expect(disc?.checksums).toEqual([{ relativePath: "clip.bin", size: 3, sha256: ABC }]);

    const flipped = bytes("abc");
    flipped[1] ^= 2;
    const bad = await runPair("optical", { "clip.bin": bytes("abc") }, { "clip.bin": flipped });
    expect(bad.discVerified).toBe(false);
    expect(bad.state).toBe("error");
    const after = await readIntegrity();
    expect(after.discs.some((item) => item.jobId === bad.id)).toBe(false);
  });

  it("does not mark localsend files matched until the transfer job is done", async () => {
    const queued = await enqueueIntegrity({
      kind: "localsend",
      title: "LocalSend",
      transferDone: false,
      source: treeReader({ "note.txt": bytes("abc") }),
      destination: treeReader({ "note.txt": bytes("abc") }),
    });
    const hashed = await waitJob(queued.id);
    expect(hashed.files.some((file) => file.status === "match")).toBe(false);
    expect(hashed.deleteAllowed).toBe(false);
    await markTransferDone(queued.id);
    const done = await waitJob(queued.id);
    expect(done.transferDone).toBe(true);
    expect(done.files.every((file) => file.status === "match")).toBe(true);
  });

  it("skips files that a checkpoint already hashed", async () => {
    const now = new Date().toISOString();
    const id = "hash-resume";
    const job: IntegrityJob = {
      id,
      kind: "torrent",
      state: "queued",
      title: "resume",
      comparable: false,
      files: [
        { relativePath: "a.txt", size: 3, sha256: ABC, status: "recorded", bytesHashed: 3, updatedAt: now, side: "source" },
        { relativePath: "b.txt", size: 3, sha256: "", status: "pending", bytesHashed: 0, updatedAt: now, side: "source" },
      ],
      checkpoint: { relativePath: "b.txt", byteOffset: 0 },
      currentFile: "a.txt",
      filesDone: 1,
      filesTotal: 2,
      bytesHashed: 3,
      bytesTotal: 6,
      percent: 50,
      speed: 0,
      etaSeconds: null,
      transferDone: true,
      userConfirmed: false,
      deleteAllowed: false,
      deleteReason: "",
      mismatchPaths: [],
      error: null,
      discVerified: false,
      sourceLabel: "",
      destinationLabel: "",
      torrentHostId: "",
      torrentHash: "",
      torrentName: "",
      rewritable: false,
      createdAt: now,
      updatedAt: now,
    };
    await mutateIntegrity((file) => {
      file.jobs.push(job);
    });
    const reads: string[] = [];
    const base = treeReader({ "a.txt": bytes("abc"), "b.txt": bytes("def") });
    await continueIntegrity(id, {
      source: {
        list: () => base.list(),
        read: async (relativePath, offset, length) => {
          reads.push(relativePath);
          return base.read(relativePath, offset, length);
        },
      },
    });
    expect(reads).not.toContain("a.txt");
    expect(reads).toContain("b.txt");
    const done = await getIntegrityJob(id);
    expect(done?.files.find((file) => file.relativePath === "a.txt")?.sha256).toBe(ABC);
    expect(done?.files.find((file) => file.relativePath === "b.txt")?.sha256).toBe(sha256Hex("def"));
  });

  it("does not delete the source fixture when hashing is cancelled", async () => {
    const root = path.join(dataDir, "source");
    await mkdir(root);
    const file = path.join(root, "note.txt");
    await writeFile(file, "abc");
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    setIntegrityGateForTests(hold);
    const queued = await enqueueIntegrity({
      kind: "copy",
      title: "copy",
      source: directoryReader(root),
      destination: directoryReader(root),
    });
    const cancelled = await cancelIntegrity(queued.id);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await readFile(file, "utf8")).toBe("abc");
    const stored = await getIntegrityJob(queued.id);
    expect(stored?.id).toBe(cancelled.id);
    expect(stored?.state).toBe("cancelled");
    expect(stored?.deleteAllowed).toBe(false);
  });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function runPair(
  kind: "move" | "copy" | "compact" | "handbrake" | "optical",
  source: Record<string, Uint8Array>,
  destination: Record<string, Uint8Array>,
  extra: { comparable?: boolean; rewritable?: boolean } = {},
) {
  const queued = await enqueueIntegrity({
    kind,
    title: kind,
    comparable: extra.comparable,
    rewritable: extra.rewritable,
    source: treeReader(source),
    destination: treeReader(destination),
  });
  return waitJob(queued.id);
}

async function waitJob(id: string) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const job = await getIntegrityJob(id);
    if (job && (job.state === "done" || job.state === "error" || job.state === "cancelled")) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`hash job ${id} did not finish`);
}
