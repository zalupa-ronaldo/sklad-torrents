"use client";

import { HardDrive, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DiskView, MediaCategory, SearchHit, SearchResponse, ShelfResponse } from "@/addons/drives/types";
import { toast } from "sonner";

const CATEGORY_LABEL: Record<MediaCategory, string> = {
  torrent: "торрент",
  game: "игра",
  media: "медиа",
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function DrivePage() {
  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<ShelfResponse>("/api/drives");
      setShelf(next);
      setLoadError(null);
      setDrafts((current) => {
        const merged = { ...current };
        for (const disk of next.disks) {
          if (focusId !== disk.id) merged[disk.id] = disk.label;
        }
        return merged;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить полку");
    } finally {
      setInitialLoading(false);
    }
  }, [focusId]);

  useEffect(() => {
    const kick = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api<SearchResponse>(`/api/drives/search?q=${encodeURIComponent(needle)}`);
          setHits(result.hits);
          setSearchError(null);
        } catch (error) {
          setSearchError(error instanceof Error ? error.message : "Поиск не выполнился");
          setHits(null);
        } finally {
          setSearching(false);
        }
      })();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("drive-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function saveLabel(disk: DiskView) {
    const next = (drafts[disk.id] ?? disk.label).trim();
    if (!next || next === disk.label) return;
    try {
      await api(`/api/drives/${disk.id}`, { method: "PATCH", body: JSON.stringify({ label: next }) });
      await refresh();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Не удалось сохранить имя";
      toast.error(message);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Склад</h1>
            <div className="mt-2">
              <AppNav current="drives" />
            </div>
          </div>
        </div>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="drive-search"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setSelected(null);
              if (!value.trim()) {
                setHits(null);
                setSearchError(null);
                setSearching(false);
              } else {
                setSearching(true);
              }
            }}
            placeholder="Файл на любом диске, даже если он на полке"
            className="pl-8"
            aria-label="Поиск по полке дисков"
          />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Полка дисков</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Диски, которые лежат отдельно, остаются в каталоге. Индексация только читает носитель: ничего не
            форматирует, не переносит и не удаляет.
          </p>
        </div>
        {shelf?.mode === "mock" ? (
          <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            Демо-режим: диски синтетические, к железу агент не подключён. Тот же серийный номер и UUID — это один
            диск, даже если точка монтирования сменилась.
          </p>
        ) : null}
        {shelf?.agentErrors.length ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {shelf.agentErrors.map((error) => (
              <p key={error.hostName}>
                {error.hostName}: {error.message}
              </p>
            ))}
          </div>
        ) : null}
        {query.trim() ? (
          <SearchPanel
            query={query.trim()}
            hits={hits}
            searching={searching}
            error={searchError}
            selected={selected}
            onSelect={setSelected}
          />
        ) : null}
        {initialLoading ? (
          <LoadingShelf />
        ) : loadError && !shelf ? (
          <div className="py-10">
            <h3 className="text-lg font-medium">Полка не загрузилась</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">{loadError}</p>
            <Button className="mt-4" onClick={() => void refresh()}>
              Повторить
            </Button>
          </div>
        ) : shelf && shelf.disks.length === 0 ? (
          <div className="py-10">
            <h3 className="text-lg font-medium">На полке пока пусто</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Подключите HDD к Mac mini или к Windows. Диск появится сам, без кнопки «сканировать».
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {shelf?.disks.map((disk) => (
              <DiskCard
                key={disk.id}
                disk={disk}
                draft={drafts[disk.id] ?? disk.label}
                onDraft={(value) => setDrafts((current) => ({ ...current, [disk.id]: value }))}
                onFocus={() => setFocusId(disk.id)}
                onBlur={() => {
                  setFocusId(null);
                  void saveLabel(disk);
                }}
              />
            ))}
          </div>
        )}
        {loadError && shelf ? <p className="text-sm text-warn">Полка могла устареть: {loadError}</p> : null}
      </main>
    </div>
  );
}

function DiskCard({
  disk,
  draft,
  onDraft,
  onFocus,
  onBlur,
}: {
  disk: DiskView;
  draft: string;
  onDraft: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const categories = (Object.keys(disk.categoryCounts) as MediaCategory[]).filter((key) => disk.categoryCounts[key] > 0);
  return (
    <article className={cn("rounded-xl border bg-card p-4", disk.online ? "border-border" : "border-border/70 opacity-90")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-2 rounded-full", disk.online ? "bg-seed" : "bg-muted-foreground")} />
            <span className="text-xs text-muted-foreground">{disk.online ? "Подключён" : "На полке"}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{disk.filesystem}</span>
            {disk.possibleClone ? (
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Возможная копия</span>
            ) : null}
            {disk.duplicateMounts ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Две точки монтирования</span>
            ) : null}
          </div>
          <label className="mt-3 block text-xs text-muted-foreground" htmlFor={`label-${disk.id}`}>
            {disk.namedByUser ? "Имя на полке" : "Имя с тома — можно заменить"}
          </label>
          <Input
            id={`label-${disk.id}`}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
            className="mt-1"
            aria-label={`Имя диска ${disk.label}`}
          />
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Объём</dt>
          <dd>
            {formatBytes(disk.totalBytes)} · свободно {formatBytes(disk.freeBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Последний хост</dt>
          <dd>{disk.lastHostName || "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Видели</dt>
          <dd>{formatWhen(disk.lastSeenAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Файлы в каталоге</dt>
          <dd>{disk.fileCount}</dd>
        </div>
      </dl>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {disk.serial || "серийный номер не прочитан"} · {disk.volumeUuid}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {disk.online
          ? `Сейчас: ${disk.mountPaths.join(", ") || "без точки монтирования"}`
          : `Последний путь: ${disk.lastMountPath || "—"}`}
      </p>
      {disk.priorMountPath ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Точка монтирования сменилась: было {disk.priorMountPath}, сейчас {disk.lastMountPath}. Это тот же диск.
        </p>
      ) : null}
      {disk.possibleClone && disk.clonePeerLabels.length > 0 ? (
        <p className="mt-1 text-xs text-warn">
          Тот же UUID, другой серийный номер: {disk.clonePeerLabels.join(", ")}. Записи не объединены.
        </p>
      ) : null}
      {categories.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {categories.map((category) => `${CATEGORY_LABEL[category]} ${disk.categoryCounts[category]}`).join(" · ")}
        </p>
      ) : null}
      <ScanLine disk={disk} />
    </article>
  );
}

function ScanLine({ disk }: { disk: DiskView }) {
  const showBar = disk.online && (disk.scan.status === "running" || disk.scan.status === "paused");
  return (
    <div className="mt-3">
      <p className={cn("text-xs", disk.scan.status === "error" ? "text-destructive" : "text-muted-foreground")}>{disk.scan.message}</p>
      {showBar ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(disk.scan.progress * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function SearchPanel({
  query,
  hits,
  searching,
  error,
  selected,
  onSelect,
}: {
  query: string;
  hits: SearchHit[] | null;
  searching: boolean;
  error: string | null;
  selected: SearchHit | null;
  onSelect: (hit: SearchHit) => void;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
        {searching ? "Ищем по всей полке…" : hits ? `${hits.length} совпадений` : "Поиск"}
      </div>
      {error ? (
        <p className="px-4 py-6 text-sm text-destructive">{error}</p>
      ) : hits && hits.length === 0 && !searching ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Ничего не нашлось по «{query}», в том числе на отключённых дисках.</p>
      ) : (
        <ul>
          {hits?.map((hit) => {
            const active = selected?.diskId === hit.diskId && selected.path === hit.path;
            return (
              <li key={`${hit.diskId}:${hit.path}`} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => onSelect(hit)}
                  className={cn("w-full px-4 py-3 text-left hover:bg-muted/40", active && "bg-muted/50")}
                >
                  <span className="block text-sm font-medium">{hit.name}</span>
                  <span className="mt-1 block font-mono text-[11px] text-muted-foreground">{hit.path}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {hit.label} · {hit.serial || "без серийного номера"} · {hit.volumeUuid} · {hit.filesystem} ·{" "}
                    {hit.online ? "диск подключён" : "диск на полке"}
                    {hit.categories.length > 0 ? ` · ${hit.categories.map((category) => CATEGORY_LABEL[category]).join(", ")}` : ""}
                  </span>
                </button>
                {active ? <HitNotice hit={hit} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function HitNotice({ hit }: { hit: SearchHit }) {
  if (!hit.online) {
    return (
      <div className="mx-4 mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
        <p className="font-medium">{hit.connectHint}</p>
        <p className="mt-1 text-muted-foreground">
          Файла сейчас нет под рукой. Каталог помнит путь, но открыть его нельзя, пока этот диск не подключён.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-4 mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      Диск «{hit.label}» подключён. Путь: {hit.path}
    </div>
  );
}

function LoadingShelf() {
  return (
    <div className="grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Загрузка полки">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-40 animate-pulse rounded-xl bg-muted/70" />
      ))}
    </div>
  );
}
