import { estimateCompactSavings } from "@/addons/media-games/compact";
import {
  applyCopy,
  applyVerify,
  buildVerifyResult,
  libraryFromPlan,
  planMove,
  type CopyReceipt,
  type FolderMoveAdapter,
} from "@/addons/media-games/move";
import type { JobRecord, LibraryRecord } from "@/addons/media-games/types";

export const MOCK_MOVE_FILES = 128;
export const MOCK_MOVE_BYTES = 52_428_800_000;

export interface MockStep {
  job: JobRecord;
  library: LibraryRecord | null;
}

/** In-memory mover. copy/verify/deleteSource never touch the filesystem. */
export function createMockMover(): FolderMoveAdapter {
  return {
    async copy(source, destination) {
      return {
        files: MOCK_MOVE_FILES,
        bytes: MOCK_MOVE_BYTES,
        marker: `mock-copy:${source}->${destination}`,
      };
    },
    async verify(_source, _destination, receipt) {
      return buildVerifyResult({ files: receipt.files, bytes: receipt.bytes }, true);
    },
    async deleteSource() {
      // The demo records the decision and leaves every real folder in place.
    },
  };
}

export async function advanceMockJob(
  job: JobRecord,
  now: number,
  mover: FolderMoveAdapter = createMockMover(),
): Promise<MockStep> {
  if (job.runner !== "mock") {
    return { job, library: null };
  }
  if (job.kind === "transcode") return { job: advanceTranscode(job, now), library: null };
  if (job.kind === "compress") return { job: advanceCompress(job, now), library: null };
  return advanceFolderJob(job, now, mover);
}

/** Copy, then verify. Delete is never performed here. */
export async function advanceFolderJob(job: JobRecord, now: number, mover: FolderMoveAdapter): Promise<MockStep> {
  return advanceMove(job, now, mover);
}

function advanceTranscode(job: JobRecord, now: number): JobRecord {
  if (job.state === "queued") {
    return touch(job, now, { state: "running", progress: 0.34, spawned: false });
  }
  if (job.state === "running" && job.progress < 0.67) {
    return touch(job, now, { progress: 0.67, spawned: false });
  }
  if (job.state === "running") {
    return touch(job, now, {
      state: "completed",
      progress: 1,
      spawned: false,
      outputMarker: `mock-output:${job.outputPath ?? ""}`,
      error: null,
    });
  }
  return job;
}

function advanceCompress(job: JobRecord, now: number): JobRecord {
  if (job.state === "queued") {
    return touch(job, now, { state: "running", progress: 0.55, spawned: false });
  }
  if (job.state === "running" && job.algorithm) {
    const savings = estimateCompactSavings(job.algorithm);
    return touch(job, now, {
      state: "completed",
      progress: 1,
      spawned: false,
      bytesBefore: savings.bytesBefore,
      bytesAfter: savings.bytesAfter,
      outputMarker: `mock-compact:${job.folderPath ?? ""}`,
      error: null,
    });
  }
  return job;
}

async function advanceMove(job: JobRecord, now: number, mover: FolderMoveAdapter): Promise<MockStep> {
  const source = job.sourcePath ?? "";
  const destination = job.destinationPath ?? "";
  if (job.state === "queued") {
    const receipt = await mover.copy(source, destination);
    return {
      job: touch(job, now, {
        state: "running",
        progress: 0.45,
        spawned: false,
        deleteSource: false,
        sourceDeleted: false,
        outputMarker: receipt.marker,
        copyFiles: receipt.files,
        copyBytes: receipt.bytes,
      }),
      library: null,
    };
  }
  if (job.state === "running") {
    return {
      job: touch(job, now, { state: "verifying", progress: 0.8, deleteSource: false, sourceDeleted: false }),
      library: null,
    };
  }
  if (job.state === "verifying") {
    const receipt = receiptFrom(job, source, destination);
    const result = await mover.verify(source, destination, receipt);
    let plan = planMove({
      hostId: job.hostId,
      os: job.hostId === "pc-agent" ? "win32" : "darwin",
      name: job.title,
      sourcePath: source,
      destinationPath: destination,
    });
    plan = applyCopy(plan, receipt);
    plan = applyVerify(plan, result);
    if (!plan.verified || !plan.verify) {
      return {
        job: touch(job, now, {
          state: "failed",
          verified: false,
          deleteSource: false,
          sourceDeleted: false,
          verify: plan.verify,
          error: plan.verify?.message ?? "Проверка не сошлась. Исходная папка не удаляется.",
        }),
        library: null,
      };
    }
    const library = libraryFromPlan(plan, job.id, now);
    return {
      job: touch(job, now, {
        state: "awaiting-confirm",
        progress: 1,
        verified: true,
        deleteSource: false,
        sourceDeleted: false,
        verify: plan.verify,
        libraryId: library.id,
        error: null,
      }),
      library,
    };
  }
  return { job, library: null };
}

function receiptFrom(job: JobRecord, source: string, destination: string): CopyReceipt {
  return {
    files: job.copyFiles ?? MOCK_MOVE_FILES,
    bytes: job.copyBytes ?? MOCK_MOVE_BYTES,
    marker: job.outputMarker ?? `mock-copy:${source}->${destination}`,
  };
}

function touch(job: JobRecord, now: number, patch: Partial<JobRecord>): JobRecord {
  return { ...job, ...patch, updatedAt: now, spawned: patch.spawned ?? false };
}
