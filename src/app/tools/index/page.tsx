"use client";

import { useRouter } from "next/navigation";

import { FileIndexPanel } from "@/addons/media-games/file-index/file-index-panel";
import type { IndexHit } from "@/addons/media-games/file-index/types";
import { gameFolderFromHit } from "@/addons/media-games/move-to-ssd/game-folder";

export default function FileIndexPage() {
  const router = useRouter();

  function pick(folder: string, hit: IndexHit) {
    const params = new URLSearchParams({
      source: folder,
      host: hit.path.startsWith("/") ? "mac-local" : "pc-agent",
      name: gameFolderFromHit({ path: folder, isDirectory: true }).split(/[/\\]/).filter(Boolean).pop() || hit.name,
    });
    router.push(`/tools/move?${params.toString()}`);
  }

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-lg font-medium">Индекс файлов</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          На Windows NTFS повышенный агент читает MFT и журнал USN. Без прав администратора и на APFS,
          включая /Volumes/vault, остаётся обход папок. Сырой диск из этой среды не читается.
        </p>
      </div>
      <FileIndexPanel onPickFolder={pick} />
    </div>
  );
}
