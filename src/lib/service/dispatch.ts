import { createJobStore } from "@/lib/jobs/engine";
import { dataDir } from "@/lib/qbittorrent/store";
import { verifySnapshotJob } from "@/lib/service/snapshot-pipeline";

/** One pass of the shared queue. Manual `work` commands stay available for debugging. */
export async function dispatchOnce(directory = dataDir()): Promise<{ processed: string[] }> {
  const processed: string[] = [];
  try {
    const snapshot = await verifySnapshotJob(createJobStore(directory));
    if (snapshot.processed) processed.push("snapshot");
  } catch {
    processed.push("snapshot-error");
  }
  try {
    const { runEncodeOnce } = await import("@/lib/transcode/encode-worker");
    const encode = await runEncodeOnce(directory);
    if (encode.processed === true) processed.push("encode");
  } catch {
    processed.push("encode-error");
  }
  try {
    const { runGameOnce } = await import("@/lib/games/prepare");
    const game = await runGameOnce(directory);
    if (game.processed === true) processed.push("game");
  } catch {
    processed.push("game-error");
  }
  return { processed };
}
