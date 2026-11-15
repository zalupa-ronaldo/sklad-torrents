import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registeredJobSources } from "@/lib/progress/sources";
import { registerTorrentTransferProgress, transferJobSnapshot } from "@/lib/torrents/transfer-progress";
import {
  controlTransferJob,
  controlTorrentTransfer,
  createTransferJob,
  hashesMatch,
  listTransferJobs,
  saveTransferPolicy,
  stepTorrentTransfers,
  type TransferJobInput,
} from "@/lib/torrents/transfer";

describe("resumable torrent copy", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-transfer-"));
    await saveTransferPolicy(dir, { chunkBytes: 10, maxBytesPerSecond: 10, maxParallel: 1, busy: false, schedule: null });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("copies a file in rate-limited chunks and leaves the source untouched", async () => {
    const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN");
    expect(bytes.length).toBe(50);
    const seeded = await seed(dir, "full", bytes);
    const before = await stat(seeded.sourcePath);
    const job = await createTransferJob(dir, seeded.input, 0);
    expect(job.status).toBe("queued");
    let now = 0;
    let current = job;
    for (let step = 0; step < 8 && current.status !== "completed"; step += 1) {
      await stepTorrentTransfers(dir, now);
      current = (await listTransferJobs(dir))[0];
      now += 1000;
    }
    expect(current.status).toBe("completed");
    expect(current.verified).toBe(true);
    expect(current.error).toBeNull();
    expect(await readFile(seeded.destPath)).toEqual(bytes);
    const after = await stat(seeded.sourcePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await readFile(seeded.sourcePath)).toEqual(bytes);
  });

  it("pauses mid-copy, reloads the job, and resumes without going backwards", async () => {
    const bytes = Buffer.alloc(50, 7);
    const seeded = await seed(dir, "pause", bytes);
    const created = await createTransferJob(dir, seeded.input, 0);
    await stepTorrentTransfers(dir, 0);
    let job = (await listTransferJobs(dir))[0];
    expect(job.files[0]?.copiedBytes).toBeGreaterThan(0);
    expect(job.files[0]?.copiedBytes).toBeLessThan(bytes.length);
    await controlTransferJob(dir, "pause", created.id, 10);
    job = (await listTransferJobs(dir))[0];
    expect(job.status).toBe("paused");
    expect(job.pauseReason).toBe("user");
    const mid = job.files[0]?.copiedBytes ?? 0;
    await controlTorrentTransfer(`torrent-transfer__${created.id}`, "resume", dir);
    const seen = [mid];
    job = (await listTransferJobs(dir))[0];
    expect(job.status).toBe("running");
    let now = 1000;
    for (let step = 0; step < 10 && job.status !== "completed"; step += 1) {
      await stepTorrentTransfers(dir, now);
      job = (await listTransferJobs(dir))[0];
      const copied = job.files[0]?.copiedBytes ?? 0;
      expect(copied).toBeGreaterThanOrEqual(seen[seen.length - 1] ?? 0);
      seen.push(copied);
      now += 1000;
    }
    expect(job.status).toBe("completed");
    expect(await readFile(seeded.destPath)).toEqual(bytes);
  });

  it("pauses a running job when the disk is busy and copies nothing more", async () => {
    const seeded = await seed(dir, "busy", Buffer.alloc(50, 3));
    await createTransferJob(dir, seeded.input, 0);
    await stepTorrentTransfers(dir, 0);
    const mid = (await listTransferJobs(dir))[0]?.files[0]?.copiedBytes;
    await saveTransferPolicy(dir, { busy: true });
    await stepTorrentTransfers(dir, 5_000);
    const job = (await listTransferJobs(dir))[0];
    expect(job?.status).toBe("paused");
    expect(job?.pauseReason).toBe("busy");
    expect(job?.files[0]?.copiedBytes).toBe(mid);
    await saveTransferPolicy(dir, { busy: false });
    await stepTorrentTransfers(dir, 6_000);
    const resumed = (await listTransferJobs(dir))[0];
    expect(resumed?.status).toBe("running");
    expect(resumed?.pauseReason).toBeNull();
    expect(resumed?.files[0]?.copiedBytes).toBeGreaterThanOrEqual(mid ?? 0);
    const source = readFileSync(fileURLToPath(new URL("./transfer.ts", import.meta.url)), "utf8");
    expect(source.includes("pauseTorrent")).toBe(false);
    expect(source.includes("setLocation")).toBe(false);
    expect(source.includes("unlink")).toBe(false);
  });

  it("cancel leaves the source and the partial destination on disk", async () => {
    const bytes = Buffer.alloc(50, 4);
    const seeded = await seed(dir, "cancel", bytes);
    const created = await createTransferJob(dir, seeded.input, 0);
    await stepTorrentTransfers(dir, 0);
    await controlTransferJob(dir, "cancel", created.id, 20);
    const job = (await listTransferJobs(dir))[0];
    expect(job?.status).toBe("cancelled");
    expect(await readFile(seeded.sourcePath)).toEqual(bytes);
    const partial = await readFile(seeded.destPath);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(bytes.length);
  });

  it("reports a hash mismatch and does not change the source", async () => {
    expect(hashesMatch(Buffer.from("same"), Buffer.from("same"))).toBe(true);
    expect(hashesMatch(Buffer.from("same"), Buffer.from("diff"))).toBe(false);
    expect(hashesMatch(Buffer.from("ab"), Buffer.from("abc"))).toBe(false);
    const sourceBytes = Buffer.alloc(40, 1);
    const seeded = await seed(dir, "hash", sourceBytes);
    await writeFile(seeded.destPath, Buffer.alloc(40, 2));
    const created = await createTransferJob(dir, seeded.input, 1);
    const stored = JSON.parse(await readFile(path.join(dir, "torrent-transfers.json"), "utf8")) as {
      jobs: { id: string; files: { copiedBytes: number }[] }[];
    };
    const row = stored.jobs.find((job) => job.id === created.id);
    if (!row?.files[0]) throw new Error("job missing");
    row.files[0].copiedBytes = sourceBytes.length;
    await writeFile(path.join(dir, "torrent-transfers.json"), JSON.stringify(stored));
    const before = await readFile(seeded.sourcePath);
    await stepTorrentTransfers(dir, 5_000);
    const job = (await listTransferJobs(dir)).find((item) => item.id === created.id);
    expect(job?.status).toBe("error");
    expect(job?.verified).toBe(false);
    expect(job?.error).toBe("Копия не совпала с источником. Исходник остаётся.");
    expect(await readFile(seeded.sourcePath)).toEqual(before);
  });

  it("advances only the older job when one copy may run", async () => {
    const older = await seed(dir, "older", Buffer.alloc(50, 5));
    const newer = await seed(dir, "newer", Buffer.alloc(50, 6));
    const first = await createTransferJob(dir, { ...older.input, name: "older" }, 1);
    const second = await createTransferJob(dir, { ...newer.input, name: "newer" }, 2);
    await stepTorrentTransfers(dir, 1_000);
    const jobs = await listTransferJobs(dir);
    expect(jobs.find((job) => job.id === first.id)?.files[0]?.copiedBytes).toBe(10);
    expect(jobs.find((job) => job.id === second.id)).toMatchObject({ status: "queued", files: [{ copiedBytes: 0 }] });
  });

  it("pauses outside the UTC window and copies inside a window that passes midnight", async () => {
    await saveTransferPolicy(dir, { schedule: { startHour: 22, endHour: 6 } });
    const seeded = await seed(dir, "hours", Buffer.alloc(50, 8));
    await createTransferJob(dir, seeded.input, 1);
    await stepTorrentTransfers(dir, Date.UTC(2026, 0, 15, 12, 0, 0));
    expect((await listTransferJobs(dir))[0]).toMatchObject({ status: "paused", pauseReason: "schedule", files: [{ copiedBytes: 0 }] });
    const night = await seed(dir, "night", Buffer.alloc(50, 9));
    const job = await createTransferJob(dir, { ...night.input, name: "night" }, 2);
    await stepTorrentTransfers(dir, Date.UTC(2026, 0, 15, 23, 0, 0));
    const jobs = await listTransferJobs(dir);
    const resumed = jobs.find((item) => item.name === "hours");
    const waiting = jobs.find((item) => item.id === job.id);
    expect(resumed).toMatchObject({ status: "running", pauseReason: null, files: [{ copiedBytes: 10 }] });
    expect(waiting).toMatchObject({ status: "queued", files: [{ copiedBytes: 0 }] });
  });

  it("rejects drive Z and a destination inside the source", async () => {
    const seeded = await seed(dir, "reject", Buffer.alloc(4, 1));
    await expect(
      createTransferJob(
        dir,
        { ...seeded.input, destRoot: "Z:\\Games", files: [{ ...seeded.input.files[0], destPath: "Z:\\Games\\file.bin" }] },
        1,
      ),
    ).rejects.toThrow("Диск Z: не используется. Выберите другой каталог.");
    await expect(
      createTransferJob(
        dir,
        {
          ...seeded.input,
          destRoot: path.join(seeded.sourceRoot, "nested"),
          files: [{ ...seeded.input.files[0], destPath: path.join(seeded.sourceRoot, "nested", "file.bin") }],
        },
        1,
      ),
    ).rejects.toThrow(/внутри исходного/);
  });

  it("publishes copy jobs with pause, resume, and cancel capabilities", async () => {
    const seeded = await seed(dir, "snap", Buffer.alloc(20, 1));
    const job = await createTransferJob(dir, seeded.input, 3);
    const queued = transferJobSnapshot(job);
    expect(queued.id).toBe(`torrent-transfer__${job.id}`);
    expect(queued.kind).toBe("copy");
    expect(queued.speed).toBe(0);
    expect(queued.eta).toBe(8_640_000);
    expect(queued.pauseUnsupportedReason).toBeNull();
    expect(queued.capabilities).toEqual({ pause: true, resume: false, cancel: true });
    expect(transferJobSnapshot({ ...job, status: "paused", pauseReason: "user" }).capabilities).toEqual({
      pause: false,
      resume: true,
      cancel: true,
    });
    expect(transferJobSnapshot({ ...job, status: "completed", verified: true }).capabilities).toEqual({
      pause: false,
      resume: false,
      cancel: false,
    });
    expect(transferJobSnapshot({ ...job, status: "running", bytesThisWindow: 10 }).speed).toBe(10);
    registerTorrentTransferProgress();
    expect(registeredJobSources().some((source) => source.id === "torrent-transfer")).toBe(true);
  });
});

async function seed(root: string, name: string, bytes: Buffer): Promise<{ sourceRoot: string; sourcePath: string; destPath: string; input: TransferJobInput }> {
  const sourceRoot = path.join(root, `${name}-src`);
  const destRoot = path.join(root, `${name}-dst`);
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(path.dirname(path.join(destRoot, "file.bin")), { recursive: true });
  const sourcePath = path.join(sourceRoot, "file.bin");
  const destPath = path.join(destRoot, "file.bin");
  await writeFile(sourcePath, bytes);
  return {
    sourceRoot,
    sourcePath,
    destPath,
    input: {
      hostId: "host",
      hash: "a".repeat(40),
      name,
      sourceRoot,
      destRoot,
      files: [{ relativeName: "file.bin", size: bytes.length, sourcePath, destPath }],
    },
  };
}
