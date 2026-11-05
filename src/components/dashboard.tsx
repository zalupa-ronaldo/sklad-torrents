"use client";

import { HardDrive, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AddTorrentDialog } from "@/components/add-torrent-dialog";
import { HostDialog } from "@/components/host-dialog";
import { HostSidebar } from "@/components/host-sidebar";
import { TorrentDetail } from "@/components/torrent-detail";
import { TorrentTable } from "@/components/torrent-table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { filterTorrents, sortTorrents, type SortKey, type StateFilter } from "@/lib/filter";
import { pluralTorrents } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { DashboardPayload, HostView, TorrentDetailPayload, TorrentView } from "@/lib/qbittorrent/types";

const FILTERS: { id: StateFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "active", label: "В работе" },
  { id: "seeding", label: "Раздача" },
  { id: "paused", label: "Пауза" },
  { id: "problem", label: "Проблемы" },
  { id: "marked", label: "К переносу" },
];

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [hostFilter, setHostFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("activity");
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
      const next = await api<DashboardPayload>("/api/torrents");
      setData(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить раздачи");
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const kick = window.setTimeout(run, 0);
    const timer = window.setInterval(run, 4000);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [refresh]);

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
    }, 4000);
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
        document.getElementById("torrent-search")?.focus();
      }
      if (event.key === "Escape" && !document.querySelector("[data-slot=dialog-content]")) {
        setSelectedKey(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(() => {
    const filtered = filterTorrents(data?.torrents ?? [], { q: query, hostId: hostFilter, state: stateFilter });
    return sortTorrents(filtered, sortKey);
  }, [data, query, hostFilter, stateFilter, sortKey]);

  const offline = (data?.hosts ?? []).filter((host) => !host.online);
  const selectedHost = data?.hosts.find((host) => host.id === selectedKey?.slice(0, selectedKey.indexOf(":")));
  const detailMatches =
    detail && selectedKey === `${detail.torrent.hostId}:${detail.torrent.hash}` ? detail : null;

  function selectTorrent(torrent: TorrentView) {
    setSelectedKey(`${torrent.hostId}:${torrent.hash}`);
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Склад</h1>
            <p className="text-xs text-muted-foreground">
              Где лежат раздачи на Mac и Windows
              <span className="px-1.5 text-border">·</span>
              <Link href="/optical" className="underline-offset-4 hover:underline">
                Диски DVD
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/drives" className="underline-offset-4 hover:underline">
                Полка дисков
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/policies" className="underline-offset-4 hover:underline">
                Правила
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/localsend" className="underline-offset-4 hover:underline">
                LocalSend
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/progress" className="underline-offset-4 hover:underline">
                Прогресс
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/scheduler" className="underline-offset-4 hover:underline">
                Очередь
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/policies" className="underline-offset-4 hover:underline">
                Правила
              </Link>
              <span className="px-1.5 text-border">·</span>
              <Link href="/tools" className="underline-offset-4 hover:underline">
                Медиа и игры
              </Link>
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="torrent-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Имя, каталог или хост"
              className="pl-8"
              aria-label="Поиск раздач"
            />
          </div>
          <Link href="/progress" className={buttonVariants({ variant: "outline" })}>
            Очередь
          </Link>
          <Link
            href="/tools"
            className="inline-flex h-8 shrink-0 items-center rounded-lg border border-input px-2.5 text-sm hover:bg-muted"
          >
            Медиа и игры
          </Link>
          <Button variant="outline" onClick={() => setHostEditor("new")}>
            Хост
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            Добавить
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <HostSidebar
          hosts={data?.hosts ?? []}
          selectedId={hostFilter}
          onSelect={setHostFilter}
          onAdd={() => setHostEditor("new")}
          onEdit={(host) => setHostEditor(host)}
          onChanged={() => void refresh()}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              {FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setStateFilter(filter.id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs",
                    stateFilter === filter.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {filter.label}
                </button>
              ))}
              <span className="ml-auto text-xs text-muted-foreground">{pluralTorrents(visible.length)}</span>
              <select
                aria-label="Сортировка"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
                className="h-7 rounded-lg border border-input bg-transparent px-2 text-xs"
              >
                <option value="activity">Сначала активные</option>
                <option value="name">По имени</option>
                <option value="progress">По прогрессу</option>
                <option value="size">По размеру</option>
              </select>
            </div>
            {offline.length > 0 ? (
              <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {offline.map((host) => (
                  <p key={host.id}>
                    {host.name}: {host.error}
                  </p>
                ))}
              </div>
            ) : null}
            {loadError && data ? (
              <div className="border-b px-4 py-2 text-sm text-warn">Список мог устареть: {loadError}</div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto">
              {initialLoading ? (
                <LoadingRows />
              ) : loadError && !data ? (
                <div className="px-4 py-16">
                  <h2 className="text-lg font-medium">Список не загрузился</h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">{loadError}</p>
                  <Button className="mt-4" onClick={() => void refresh()}>
                    Повторить
                  </Button>
                </div>
              ) : visible.length === 0 ? (
                <div className="px-4 py-16">
                  <h2 className="text-lg font-medium">
                    {query.trim() ? `Ничего не нашлось по «${query.trim()}»` : "Нет раздач в этом виде"}
                  </h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    {query.trim()
                      ? "Поиск смотрит имя, каталог и хост."
                      : "Добавьте магнет или .torrent и выберите диск: на Mac это /Volumes/vault/…, на Windows — D:\\…"}
                  </p>
                </div>
              ) : (
                <TorrentTable torrents={visible} selectedKey={selectedKey} onSelect={selectTorrent} />
              )}
            </div>
          </main>
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
      </div>
      <AddTorrentDialog
        open={addOpen}
        hosts={data?.hosts ?? []}
        defaultHostId={hostFilter === "all" ? (data?.hosts[0]?.id ?? "") : hostFilter}
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

function LoadingRows() {
  return (
    <div className="grid gap-3 px-4 py-4">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-12 animate-pulse rounded-lg bg-muted/70" />
      ))}
    </div>
  );
}
