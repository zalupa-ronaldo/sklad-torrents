"use client";

import { FormEvent, useEffect, useState } from "react";

import { sourceBadgeLabel } from "@/addons/media-games/file-index/labels";
import type { IndexHit, IndexSource, IndexStatus } from "@/addons/media-games/file-index/types";
import { gameFolderFromHit } from "@/addons/media-games/move-to-ssd/game-folder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
interface SearchPayload {
  hits: IndexHit[];
}

export function FileIndexPanel({ onPickFolder }: { onPickFolder?: (folder: string, hit: IndexHit) => void }) {
  const [statuses, setStatuses] = useState<IndexStatus[]>([]);
  const [query, setQuery] = useState("Hades");
  const [hits, setHits] = useState<IndexHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rebuild(nextQuery = query) {
    setBusy(true);
    try {
      const built = await api<IndexStatus[]>("/api/media/index", {
        method: "POST",
        body: JSON.stringify({ id: "all" }),
      });
      setStatuses(built);
      const found = await api<SearchPayload>(`/api/media/search?q=${encodeURIComponent(nextQuery)}`);
      setHits(found.hits);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Индекс не ответил");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const kick = window.setTimeout(() => void rebuild("Hades"), 0);
    return () => window.clearTimeout(kick);
    // The first build is the demo entry point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void rebuild(query);
  }

  const mac = statuses.find((status) => status.volume.startsWith("/Volumes"));
  const windows = statuses.find((status) => status.host === "Windows PC" || /^[A-Za-z]:$/.test(status.volume));

  return (
    <div className="grid gap-6">
      <section className="grid gap-3 md:grid-cols-2">
        <VolumeCard
          title="Mac mini"
          volume="/Volumes/vault"
          status={mac}
          empty="APFS. Индекс строится обходом папок, MFT не используется."
        />
        <VolumeCard
          title="Windows PC"
          volume="D:"
          status={windows}
          empty="Том NTFS. Без прав администратора MFT недоступен, остаётся обход папок."
        />
      </section>

      {windows && windows.source === "walk" && !windows.elevated ? (
        <p className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          Индекс MFT недоступен. Результаты Windows получены обходом папок, сырой том не открывался.
          {windows.message ? ` ${windows.message}` : ""}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Имя игры или часть пути"
          aria-label="Поиск по индексу файлов"
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Ищем…" : "Найти"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void rebuild(query)}>
          Обновить индекс
        </Button>
      </form>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <ul className="grid gap-2">
        {hits.length === 0 && !busy ? (
          <li className="text-sm text-muted-foreground">Ничего не нашлось. Индекс смотрит имя и полный путь.</li>
        ) : null}
        {hits.map((hit) => (
          <li key={`${hit.host}:${hit.path}`} className="rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{hit.name}</p>
              <Badge variant={badgeVariant(hit.source)}>{sourceBadgeLabel(hit.source)}</Badge>
              <span className="text-xs text-muted-foreground">{hit.isDirectory ? "папка" : formatBytes(hit.size)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{hit.host}</p>
            <p className="mt-1 font-mono text-[11px] break-all">{hit.path}</p>
            {onPickFolder ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => onPickFolder(gameFolderFromHit(hit), hit)}
              >
                Выбрать папкой источника
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VolumeCard({
  title,
  volume,
  status,
  empty,
}: {
  title: string;
  volume: string;
  status: IndexStatus | undefined;
  empty: string;
}) {
  const source = status?.source ?? "walk";
  return (
    <article className="rounded-xl border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Badge variant={badgeVariant(source)}>{sourceBadgeLabel(source)}</Badge>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{status?.volume ?? volume}</p>
      <p className="mt-2 text-sm text-muted-foreground">{status?.message ?? empty}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {status
          ? `${status.fileCount} записей · ${status.elevated ? "процесс повышен" : "без повышения"} · ${formatBuilt(status.lastBuilt)}`
          : "Индекс ещё не построен"}
      </p>
    </article>
  );
}

function badgeVariant(source: IndexSource): "default" | "secondary" | "outline" {
  if (source === "mft") return "default";
  if (source === "usn") return "secondary";
  return "outline";
}

function formatBuilt(value: string | null): string {
  if (!value) return "ещё не строился";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(date);
}
