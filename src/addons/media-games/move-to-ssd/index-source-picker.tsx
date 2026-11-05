"use client";

import { FormEvent, useState } from "react";
import { toast } from "sonner";

import { sourceBadgeLabel } from "@/addons/media-games/file-index/labels";
import type { IndexHit } from "@/addons/media-games/file-index/types";
import { gameFolderFromHit } from "@/addons/media-games/move-to-ssd/game-folder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

/** Search the file index and hand the chosen game folder to the move wizard. */
export function IndexFolderSearch({ onPick }: { onPick: (folder: string, hit: IndexHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<IndexHit[]>([]);
  const [busy, setBusy] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await api<{ hits: IndexHit[] }>(`/api/media/search?q=${encodeURIComponent(query)}`);
      setHits(payload.hits);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Поиск по индексу не удался");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <form onSubmit={(event) => void search(event)} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Найти папку игры в индексе"
          aria-label="Поиск папки игры в индексе"
        />
        <Button type="submit" variant="outline" disabled={busy}>
          Искать в индексе
        </Button>
      </form>
      {hits.length > 0 ? (
        <ul className="grid max-h-64 gap-1 overflow-auto">
          {hits.map((hit) => (
            <li key={`${hit.host}:${hit.path}`}>
              <button
                type="button"
                className="w-full rounded-lg border px-3 py-2 text-left hover:bg-muted"
                onClick={() => onPick(gameFolderFromHit(hit), hit)}
              >
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  {hit.host}
                  <Badge variant="outline">{sourceBadgeLabel(hit.source)}</Badge>
                </span>
                <span className="mt-1 block font-mono text-[11px] break-all">{gameFolderFromHit(hit)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
