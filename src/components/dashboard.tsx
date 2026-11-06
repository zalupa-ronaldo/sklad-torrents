"use client";

import { Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AddTorrentDialog } from "@/components/add-torrent-dialog";
import { HostDialog } from "@/components/host-dialog";
import { TorrentDetail } from "@/components/torrent-detail";
import { TorrentTable } from "@/components/torrent-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isShelfDiskUseful } from "@/lib/policies/auto-routes";
import { ApiError, api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { pluralTorrents } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { DiskView, MediaCategory, SearchHit, SearchResponse, ShelfResponse } from "@/addons/drives/types";
import type { DashboardPayload, HostView, TorrentDetailPayload, TorrentView } from "@/lib/qbittorrent/types";
import type { ProgressPayload } from "@/lib/progress/jobs";
import type { JobSnapshot } from "@/lib/progress/types";

const CATEGORY_CHIPS: { id: "all" | MediaCategory; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "game", label: "Игры" },
  { id: "media", label: "Фильмы" },
  { id: "series", label: "Сериалы" },
  { id: "installer", label: "Установщики" },
  { id: "music", label: "Музыка" },
  { id: "software", label: "Софт" },
  { id: "documents", label: "Документы" },
];

const CATEGORY_LABEL: Record<MediaCategory, string> = {
  torrent: "торрент",
  game: "игра",
  media: "фильм",
  series: "сериал",
  installer: "установщик",
  music: "музыка",
  software: "софт",
  documents: "документы",
};

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedHit, setSelectedHit] = useState<SearchHit | null>(null);
  const [libFilter, setLibFilter] = useState<"all" | MediaCategory>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<TorrentDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  if (selectedKey !== trackedKey) {
    setTrackedKey(selectedKey);
    setDetailLoading(Boolean(selectedKey));
    if (selectedKey) setDetailError(null);
  }
  const [addOpen, setAddOpen] = useState(false);
  const [hostEditor, setHostEditor] = useState<HostView | null | "new">(null);

  const refresh = useCallback(async () => {
    try {
      const [nextTorrents, nextShelf, nextProgress] = await Promise.all([
        api<DashboardPayload>("/api/torrents"),
        api<ShelfResponse>("/api/drives"),
        api<ProgressPayload>("/api/progress"),
      ]);
      setData(nextTorrents);
      setShelf(nextShelf);
      setProgress(nextProgress);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить Склад");
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const kick = window.setTimeout(run, 0);
    const timer = window.setInterval(run, 5000);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [refresh]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setHits(null);
      setSearchError(null);
      setSearching(false);
      setSelectedHit(null);
      return;
    }
    setSearching(true);
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
    if (!selectedKey) return;
    const splitAt = selectedKey.indexOf(":");
    const hostId = selectedKey.slice(0, splitAt);
    const hash = selectedKey.slice(splitAt + 1);
    let cancelled = false;
    const load = (quiet: boolean) => {
      void (async () => {
        try {
          const next = await api<TorrentDetailPayload>(`/api/torrents/${hostId}/${hash}`);
          if (cancelled) return;
          setDetail(next);
          setDetailError(null);
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 404) {
            setSelectedKey(null);
            setDetail(null);
            return;
          }
          setDetailError(error instanceof Error ? error.message : "Не удалось открыть раздачу");
        } finally {
          if (!cancelled && !quiet) setDetailLoading(false);
        }
      })();
    };
    const kick = window.setTimeout(() => load(false), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [selectedKey, detailNonce]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("sklad-search")?.focus();
      }
      if (event.key === "Escape" && !document.querySelector("[data-slot=dialog-content]")) {
        setSelectedKey(null);
        setSelectedHit(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const disks = useMemo(() => {
    const list = (shelf?.disks ?? []).filter(isShelfDiskUseful);
    return list.sort((a, b) => Number(b.online) - Number(a.online) || b.fileCount - a.fileCount || a.label.localeCompare(b.label, "ru"));
  }, [shelf]);

  const visibleHits = useMemo(() => {
    if (!hits) return null;
    if (libFilter === "all") return hits;
    return hits.filter((hit) => hit.categories.includes(libFilter));
  }, [hits, libFilter]);

  const railJobs = useMemo(() => {
    const jobs = progress?.jobs ?? [];
    const active = jobs.filter((job) => job.status === "running" || job.status === "paused" || job.status === "queued" || job.status === "error");
    const scanJobs: JobSnapshot[] = disks
      .filter((disk) => disk.scan.status === "running" || disk.scan.status === "paused")
      .map((disk) => ({
        id: `scan-${disk.id}`,
        kind: "index" as const,
        title: `Индекс · ${disk.label || disk.lastMountPath || disk.id}`,
        status: disk.scan.status === "paused" ? ("paused" as const) : ("running" as const),
        progress: disk.scan.progress,
        processedBytes: 0,
        totalBytes: 0,
        speed: 0,
        eta: 0,
        currentFile: null,
        host: disk.lastHostName || null,
        diskLabel: disk.label,
        outputPath: disk.lastMountPath || null,
        error: null,
        capabilities: { pause: false, resume: false, cancel: false },
        pauseUnsupportedReason: null,
        updatedAt: Date.now(),
      }));
    const merged = [...scanJobs, ...active];
    const seen = new Set<string>();
    return merged.filter((job) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    }).slice(0, 12);
  }, [progress, disks]);

  const selectedHost = data?.hosts.find((host) => host.id === selectedKey?.slice(0, selectedKey.indexOf(":")));
  const detailMatches = detail && selectedKey === `${detail.torrent.hostId}:${detail.torrent.hash}` ? detail : null;
  const queues = progress?.queues ?? [];

  function selectTorrent(torrent: TorrentView) {
    setSelectedKey(`${torrent.hostId}:${torrent.hash}`);
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">С</span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Склад</h1>
            <p className="truncate text-xs text-muted-foreground">Подключил диск или добавил торрент — дальше само</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-seed/40 bg-seed/10 px-2.5 py-1 text-xs font-semibold text-seed">
            <span className="size-1.5 animate-pulse rounded-full bg-seed" />
            Автоматически
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="sklad-search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedHit(null);
              }}
              placeholder="Найти файл на любом диске, даже отключённом"
              className="pl-8"
              aria-label="Поиск по каталогу дисков"
            />
          </div>
          <Button variant="outline" onClick={() => setHostEditor("new")}>
            Хост
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            Торрент
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b bg-card/40 px-4 py-2 text-xs text-muted-foreground">
        <span>
          <strong className="font-semibold text-seed">Склад всё разложит сам</strong> — по папкам категорий
        </span>
        <span className="text-border">·</span>
        {(data?.hosts ?? []).map((host) => (
          <button
            key={host.id}
            type="button"
            onClick={() => setHostEditor(host)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-foreground hover:bg-muted"
            title={host.error || host.name}
          >
            <span className={cn("size-1.5 rounded-full", host.online ? "bg-seed" : "bg-muted-foreground")} />
            {host.name}
          </button>
        ))}
        <span className="text-border">·</span>
        <span>оригиналы не удаляются · перенос с контрольной суммой</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-3 md:p-4">
          <SectionTitle title="Диски" hint="куда класть — выбирает Склад по категории и свободному месту" />
          {initialLoading ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="h-28 animate-pulse rounded-xl bg-muted/70" />
              ))}
            </div>
          ) : disks.length === 0 ? (
            <p className="rounded-xl border border-dashed px-3 py-6 text-sm text-muted-foreground">Дисков в каталоге пока нет. Подключите том — он появится сам.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {disks.map((disk) => (
                <DiskCard key={disk.id} disk={disk} queue={queues.find((item) => item.label === disk.label || item.diskKey.includes(disk.id) || (disk.lastMountPath && item.diskKey.toLowerCase().includes(disk.lastMountPath.replace(/\\/g, "/").toLowerCase())))} />
              ))}
            </div>
          )}

          <SectionTitle title="Категории" hint="по папкам, не по расширениям" />
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => setLibFilter(chip.id)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  libFilter === chip.id ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {query.trim() ? (
            <SearchPanel
              query={query.trim()}
              hits={visibleHits}
              searching={searching}
              error={searchError}
              selected={selectedHit}
              onSelect={setSelectedHit}
            />
          ) : null}

          <SectionTitle title="Раздачи" hint={(data?.hosts ?? []).map((host) => host.name).join(" · ") || "хосты"} />
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-seed/15 px-2 py-0.5 font-semibold text-seed">авто</span>
              <span>скачал → Склад сам положит в нужную папку на нужный диск</span>
              <span className="ml-auto">{pluralTorrents(data?.torrents.length ?? 0)}</span>
            </div>
            {loadError && !data ? (
              <div className="px-3 py-8 text-sm">
                <p className="font-medium">Список не загрузился</p>
                <p className="mt-1 text-muted-foreground">{loadError}</p>
                <Button className="mt-3" onClick={() => void refresh()}>
                  Повторить
                </Button>
              </div>
            ) : (data?.torrents.length ?? 0) === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">
                <p>
                  <b className="font-semibold text-foreground">Раздач нет — это нормально.</b> Добавьте магнет или .torrent. Диск и папку выбирать не нужно.
                </p>
              </div>
            ) : (
              <TorrentTable
                torrents={data?.torrents ?? []}
                selectedKey={selectedKey}
                onSelect={selectTorrent}
              />
            )}
          </section>
          {loadError && data ? <p className="text-sm text-warn">Список мог устареть: {loadError}</p> : null}
        </main>

        <aside className="flex w-full shrink-0 flex-col gap-2 border-t bg-card/30 p-3 lg:w-[300px] lg:border-t-0 lg:border-l">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Сейчас делает</h2>
          {railJobs.length === 0 ? (
            <p className="rounded-xl border border-dashed px-3 py-4 text-xs text-muted-foreground">Сейчас тишина — нет активных задач и сканов.</p>
          ) : (
            railJobs.map((job) => <JobRailCard key={job.id} job={job} />)
          )}
          {(progress?.queues ?? []).filter((queue) => queue.active || queue.waiting.length > 0).length > 0 ? (
            <>
              <h2 className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Очереди дисков</h2>
              {(progress?.queues ?? [])
                .filter((queue) => queue.active || queue.waiting.length > 0)
                .map((queue) => (
                  <div key={queue.diskKey || queue.label} className="rounded-xl border bg-card px-3 py-2 text-xs">
                    <div className="font-medium">{queue.label || queue.diskKey}</div>
                    <div className="mt-1 text-muted-foreground">
                      {queue.online ? "онлайн" : "офлайн"}
                      {queue.active ? ` · качает: ${queue.active.name}` : " · свободно"}
                      {queue.waiting.length ? ` · в очереди ${queue.waiting.length}` : ""}
                    </div>
                  </div>
                ))}
            </>
          ) : null}
          <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground">
            Подключите диск или добавьте торрент. Склад сам выбирает папку категории и диск со свободным местом.
          </p>
        </aside>

        {selectedKey ? (
          <TorrentDetail
            detail={detailMatches}
            loading={detailLoading}
            error={detailError}
            presets={selectedHost?.pathPresets ?? []}
            onClose={() => setSelectedKey(null)}
            onChanged={() => {
              setDetailNonce((value) => value + 1);
              void refresh();
            }}
          />
        ) : null}
      </div>

      <AddTorrentDialog
        open={addOpen}
        hosts={data?.hosts ?? []}
        defaultHostId={data?.hosts.find((host) => host.online)?.id ?? data?.hosts[0]?.id ?? ""}
        onClose={() => setAddOpen(false)}
        onAdded={(hostId, hash) => {
          void refresh();
          if (hash) setSelectedKey(`${hostId}:${hash}`);
        }}
      />
      <HostDialog
        open={hostEditor !== null}
        host={hostEditor && hostEditor !== "new" ? hostEditor : null}
        onClose={() => setHostEditor(null)}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-slate-300 uppercase">{title}</h2>
      <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}

function DiskCard({
  disk,
  queue,
}: {
  disk: DiskView;
  queue?: { active?: { name: string } | null; waiting: unknown[] } | undefined;
}) {
  const cats = (Object.keys(disk.categoryCounts) as MediaCategory[]).filter((key) => disk.categoryCounts[key] > 0);
  const path = disk.online ? disk.mountPaths[0] || disk.lastMountPath : disk.lastMountPath;
  return (
    <article className={cn("min-w-0 rounded-xl border bg-card px-3 py-2.5", disk.online ? "border-border" : "border-dashed opacity-90")}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", disk.online ? "bg-seed" : "bg-muted-foreground")} />
        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", disk.online ? "bg-seed/15 text-seed" : "bg-muted text-muted-foreground")}>
          {disk.online ? "онлайн" : "на полке"}
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{disk.filesystem || "—"}</span>
      </div>
      <div className="truncate text-sm font-semibold">{disk.label || path || disk.id}</div>
      <div className="mt-1 truncate text-xs">
        <b className="font-semibold">{formatBytes(disk.freeBytes)}</b> свободно из {formatBytes(disk.totalBytes)}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {disk.lastHostName || "—"}
        {queue?.active ? " · очередь занята" : ""}
        {queue && !queue.active && queue.waiting.length ? ` · в очереди ${queue.waiting.length}` : ""}
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{path || "без пути"}</div>
      {cats.length > 0 ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {cats.slice(0, 4).map((cat) => CATEGORY_LABEL[cat]).join(" · ")}
        </div>
      ) : null}
    </article>
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
    <section className="flex max-h-64 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex justify-between gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {searching ? "Ищем…" : hits ? `${hits.length} · «${query}»` : `«${query}»`}
        </span>
        <span>включая диски на полке</span>
      </div>
      <div className="min-h-0 overflow-auto">
        {error ? (
          <p className="px-3 py-4 text-sm text-destructive">{error}</p>
        ) : hits && hits.length === 0 && !searching ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Ничего нет, в том числе на дисках на полке.</p>
        ) : (
          hits?.map((hit) => {
            const active = selected?.diskId === hit.diskId && selected.path === hit.path;
            return (
              <button
                key={`${hit.diskId}:${hit.path}`}
                type="button"
                onClick={() => onSelect(hit)}
                className={cn("w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/40", active && "bg-muted/50")}
              >
                <div className="text-sm font-semibold">{hit.name}</div>
                <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{hit.path}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {hit.label} · {hit.online ? "онлайн" : "на полке"}
                  {hit.categories.length ? ` · ${hit.categories.map((cat) => CATEGORY_LABEL[cat]).join(", ")}` : ""}
                </div>
                {active && !hit.online ? (
                  <div className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs">
                    <b>{hit.connectHint || "Подключите диск"}</b>
                    <div className="text-muted-foreground">В каталоге есть — открыть нельзя, пока диск не подключён.</div>
                  </div>
                ) : null}
                {active && hit.online ? (
                  <div className="mt-2 rounded-lg border border-primary/30 bg-primary/10 px-2 py-1.5 text-xs text-muted-foreground">
                    Диск «{hit.label}» подключён. Путь готов.
                  </div>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function JobRailCard({ job }: { job: JobSnapshot }) {
  const pct = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <div className="text-xs font-semibold">{job.title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        {[job.diskLabel, job.host, job.currentFile, job.error].filter(Boolean).join(" · ") || job.status}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", job.status === "error" ? "bg-destructive" : "bg-seed")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
