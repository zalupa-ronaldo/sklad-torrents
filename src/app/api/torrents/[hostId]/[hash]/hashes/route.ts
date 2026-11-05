import { guard, json } from "@/app/api/respond";
import { directoryReader } from "@/lib/integrity/hash";
import { enqueueIntegrity, torrentManifest } from "@/lib/integrity/engine";
import { manifestFilename } from "@/lib/integrity/manifest";
import { getTorrentDetail } from "@/lib/qbittorrent/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ hostId: string; hash: string }> }) {
  return guard(async () => {
    const { hostId, hash } = await context.params;
    return json(await torrentManifest(hostId, hash));
  });
}

export async function POST(_request: Request, context: { params: Promise<{ hostId: string; hash: string }> }) {
  return guard(async () => {
    const { hostId, hash } = await context.params;
    const detail = await getTorrentDetail(hostId, hash);
    if (detail.torrent.progress < 0.999) {
      return json({ error: "Раздача ещё не докачана до 100%." }, 400);
    }
    const stored = await torrentManifest(hostId, hash);
    if (stored.ready) return json({ ...stored, enqueued: false });
    const root = detail.torrent.contentPath || detail.torrent.savePath;
    const job = await enqueueIntegrity({
      kind: "torrent",
      title: `SHA-256 · ${detail.torrent.name}`,
      source: directoryReader(root),
      sourceLabel: root,
      torrent: { hostId, hash, name: detail.torrent.name },
    });
    return json({
      ready: false,
      enqueued: job.state === "queued" || job.state === "running",
      filename: manifestFilename(detail.torrent.name),
      text: "",
      files: job.files,
      job,
    });
  });
}
