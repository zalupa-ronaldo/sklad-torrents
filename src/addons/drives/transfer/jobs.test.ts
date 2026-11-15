import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cancelTransferJob, getTransferJob, seedTransferJobForTests, type TransferJob } from "@/addons/drives/transfer/jobs";

let dir = "";
let previous: string | undefined;

afterEach(async () => {
  if (previous === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previous;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("verified copy", () => {
  it("cancels a paused copy without deleting the source", async () => {
    previous = process.env.SKLAD_DATA_DIR;
    dir = await mkdtemp(path.join(os.tmpdir(), "sklad-copy-"));
    process.env.SKLAD_DATA_DIR = dir;
    const source = path.join(dir, "source.bin");
    const partial = path.join(dir, "part.bin");
    await writeFile(source, "abc");
    await writeFile(partial, "ab");
    const now = Date.now();
    const job: TransferJob = {
      id: "job-1",
      status: "paused",
      title: "Копирование",
      sourceDiskId: "disk",
      sourcePath: "source.bin",
      destinationId: "mac-downloads",
      destinationLabel: "Mac",
      destPath: null,
      bytesDone: 2,
      bytesTotal: 3,
      speed: 0,
      sourceSha256: null,
      destSha256: null,
      verified: false,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      byteOffset: 2,
      hashState: null,
      partialPath: partial,
      pauseCause: "user",
    };
    seedTransferJobForTests(job);
    expect(cancelTransferJob("transfer__job-1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(existsSync(source)).toBe(true);
    expect(existsSync(partial)).toBe(false);
    expect(getTransferJob("job-1")?.error).toMatch(/не удалялся/);
    expect(getTransferJob("job-1")?.verified).toBe(false);
  });
});
