"use client";

import { ChevronLeft, ChevronRight, Folder, File as FileIcon, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AddTorrentDialog } from "@/components/add-torrent-dialog";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayDiskName, displayDiskPickerLabel, displayDiskTitle, isStripDisk } from "@/addons/drives/inventory";
import type { TransferDestination, TransferJob } from "@/addons/drives/transfer/jobs";
import type { BrowseEntry, BrowseResponse } from "@/addons/drives/browse";
import type { DiskView, MediaCategory, SearchHit, SearchResponse, ShelfResponse } from "@/addons/drives/types";
import { api } from "@/lib/api-client";
import { formatBytes, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardPayload, HostView } from "@/lib/qbittorrent/types";
import type { ProgressPayload } from "@/lib/progress/jobs";

type SortKey = "size" | "name" | "mtime" | "type";

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

function formatMtime(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date);
}

/** Logical size plus share of the open folder. Share is bytes / folder bytes, never a file count. */
function formatSizeShare(size: number, scopeBytes: number): string {
  const bytes = formatBytes(size);
  if (!(scopeBytes > 0)) return bytes;
  const share = size <= 0 ? 0 : Math.min(1, size / scopeBytes);
  return `${bytes} · ${formatPercent(share)}`;
}

function folderHint(size: number, fileCount: number, allocated: number | null): string {
  const parts = [formatBytes(size), `${fileCount.toLocaleString("ru-RU")} ф.`];
  if (allocated != null) parts.push(`выделено ${formatBytes(allocated)}`);
  return parts.join(" · ");
}

export function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(true);
  const [diskId, setDiskId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [libFilter, setLibFilter] = useState<"all" | MediaCategory>("all");
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [selected, setSelected] = useState<BrowseEntry | SearchHit | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [hostEditor, setHostEditor] = useState<HostView | null | "new">(null);
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [copyOpen, setCopyOpen] = useState(false);
  const [destinations, setDestinations] = useState<TransferDestination[]>([]);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [copyJob, setCopyJob] = useState<TransferJob | null>(null);

  const refreshMeta = useCallback(async () => {
    try {
      const [nextTorrents, nextShelf, nextProgress] = await Promise.all([
        api<DashboardPayload>("/api/torrents"),
        api<ShelfResponse>("/api/drives"),
        api<ProgressPayload>("/api/progress"),
      ]);
      setData(nextTorrents);
      setShelf(nextShelf);
      setProgress(nextProgress);
    } catch {
      // Keep last good shelf/browse visible.
    }
  }, []);

  const loadBrowse = useCallback(async (nextDiskId: string | null, nextPath: string, appendCursor?: number) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const params = new URLSearchParams();
      if (nextDiskId) params.set("diskId", nextDiskId);
      if (nextPath) params.set("path", nextPath);
      params.set("limit", "300");
      if (appendCursor != null) params.set("cursor", String(appendCursor));
      const page = await api<BrowseResponse>(`/api/drives/browse?${params}`);
      setBrowse((prev) => {
        if (appendCursor != null && prev && prev.diskId === page.diskId && prev.relativePath === page.relativePath) {
          return { ...page, entries: [...prev.entries, ...page.entries] };
        }
        return page;
      });
      setDiskId(nextDiskId);
      setPath(nextPath);
      setSelected(null);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : "Не удалось открыть каталог");
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!copyJob || (copyJob.status !== "running" && copyJob.status !== "queued")) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const data = await api<{ job: TransferJob }>(`/api/files/copy/${copyJob.id}`);
          setCopyJob(data.job);
          if (data.job.status === "completed" || data.job.status === "error" || data.job.status === "cancelled") {
            void refreshMeta();
          }
        } catch {
          // keep last status
        }
      })();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [copyJob, refreshMeta]);


  useEffect(() => {
    const want = (window as unknown as { __skladSelect?: string }).__skladSelect;
    if (!want || !browse?.entries?.length) return;
    const hit = browse.entries.find((entry) => entry.name === want || entry.relativePath.endsWith(want));
    if (hit) {
      setSelected(hit);
      delete (window as unknown as { __skladSelect?: string }).__skladSelect;
      const params = new URLSearchParams(window.location.search);
      if (params.get("copy") === "1") {
        window.setTimeout(() => {
          void (async () => {
            try {
              const data = await api<{ destinations: TransferDestination[] }>(`/api/files/destinations?diskId=${encodeURIComponent(hit.diskId)}`);
              setDestinations(data.destinations);
              setCopyOpen(true);
            } catch {
              // ignore for screenshot helper
            }
          })();
        }, 300);
      }
    }
  }, [browse]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const startDisk = params.get("diskId");
    const startPath = params.get("path") || "";
    const selectName = params.get("select");
    const kick = window.setTimeout(() => {
      void refreshMeta();
      void (async () => {
        await loadBrowse(startDisk, startPath);
        if (selectName) {
          // selection applied in a follow-up effect once browse arrives
          (window as unknown as { __skladSelect?: string }).__skladSelect = selectName;
        }
      })();
    }, 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshMeta();
    }, 8000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [refreshMeta, loadBrowse]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api<SearchResponse>(`/api/drives/search?q=${encodeURIComponent(needle)}&limit=200`);
          setHits(result.hits);
        } catch {
          setHits([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const stripDisks = useMemo(() => {
    return (shelf?.disks ?? []).filter(isStripDisk).sort((a, b) => b.fileCount - a.fileCount || a.label.localeCompare(b.label, "ru"));
  }, [shelf]);

  const treeDisks = useMemo(() => {
    if (browse?.roots) return browse.entries;
    return stripDisks
      .filter((disk) => disk.fileCount > 0)
      .map((disk) => ({
        diskId: disk.id,
        diskLabel: displayDiskTitle(disk),
        online: disk.online,
        name: displayDiskTitle(disk),
        relativePath: "",
        displayPath: disk.mountPaths[0] || disk.lastMountPath,
        kind: "dir" as const,
        size: disk.indexedBytes,
        allocated: null,
        mtimeMs: 0,
        extension: "",
        categories: [],
        fileCount: disk.fileCount,
        dirCount: 0,
      }));
  }, [browse, stripDisks]);

  const rows = useMemo(() => {
    if (query.trim() && hits) {
      return hits
        .filter((hit) => libFilter === "all" || hit.categories.includes(libFilter))
        .map((hit) => ({
          key: `${hit.diskId}:${hit.path}`,
          name: hit.name,
          kind: hit.kind,
          extension: hit.kind === "dir" ? "" : (hit.name.split(".").pop() || "").toLowerCase(),
          size: null as number | null,
          allocated: null as number | null,
          fileCount: 0,
          mtimeMs: 0,
          diskLabel: hit.label,
          path: hit.path,
          online: hit.online,
          raw: hit,
        }));
    }
    const entries = (browse?.entries ?? []).filter((entry) => {
      if (libFilter === "all") return true;
      return entry.categories.includes(libFilter);
    });
    const sorted = [...entries];
    sorted.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name, "ru");
      if (sortKey === "mtime") return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      if (sortKey === "type") return (a.extension || a.kind).localeCompare(b.extension || b.kind) || b.size - a.size || b.fileCount - a.fileCount;
      return b.size - a.size || (b.allocated ?? 0) - (a.allocated ?? 0) || b.fileCount - a.fileCount || a.name.localeCompare(b.name, "ru");
    });
    return sorted.map((entry) => ({
      key: `${entry.diskId}:${entry.relativePath}`,
      name: entry.name,
      kind: entry.kind,
      extension: entry.extension,
      size: entry.size,
      allocated: entry.allocated,
      fileCount: entry.fileCount,
      mtimeMs: entry.mtimeMs,
      diskLabel: entry.diskLabel,
      path: entry.displayPath,
      online: entry.online,
      raw: entry,
    }));
  }, [browse, hits, query, libFilter, sortKey]);

  function openEntry(entry: BrowseEntry) {
    if (entry.kind !== "dir") {
      setSelected(entry);
      return;
    }
    // Root disk row from roots list has empty relativePath and diskId.
    void loadBrowse(entry.diskId, entry.relativePath || "");
    setTreeOpen((current) => ({ ...current, [entry.diskId]: true }));
  }

  function goUp() {
    if (!diskId) return;
    if (!path) {
      void loadBrowse(null, "");
      return;
    }
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    void loadBrowse(diskId, parent);
  }

  function openDisk(disk: DiskView) {
    void loadBrowse(disk.id, "");
    setTreeOpen((current) => ({ ...current, [disk.id]: true }));
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("sklad-search")?.focus();
        return;
      }
      if (event.key === "Backspace" || event.key === "ArrowLeft") {
        event.preventDefault();
        goUp();
        return;
      }
      if (event.key === "Enter" || event.key === "ArrowRight") {
        if (selected && "kind" in selected && selected.kind === "dir") {
          event.preventDefault();
          openEntry(selected as BrowseEntry);
        }
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!rows.length) return;
        event.preventDefault();
        const keys = rows.map((row) => row.key);
        const currentKey =
          selected && "relativePath" in selected
            ? `${(selected as BrowseEntry).diskId}:${(selected as BrowseEntry).relativePath}`
            : selected && "path" in selected
              ? `${(selected as SearchHit).diskId}:${(selected as SearchHit).path}`
              : null;
        let index = currentKey ? keys.indexOf(currentKey) : -1;
        index = event.key === "ArrowDown" ? Math.min(keys.length - 1, index + 1) : Math.max(0, index <= 0 ? 0 : index - 1);
        const next = rows[index];
        if (next) setSelected(next.raw as BrowseEntry);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sklad-keynav
  }, [selected, rows, diskId, path]);

  const crumbs = useMemo(() => {
    const parts: { label: string; diskId: string | null; path: string }[] = [{ label: "Диски", diskId: null, path: "" }];
    if (!diskId) return parts;
    parts.push({ label: browse?.diskLabel || "Диск", diskId, path: "" });
    if (path) {
      const segs = path.split("/");
      let acc = "";
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        parts.push({ label: seg, diskId, path: acc });
      }
    }
    return parts;
  }, [diskId, path, browse?.diskLabel]);

  const activity = (progress?.jobs ?? [])
    .filter((job) => job.status === "running" || job.status === "paused" || job.status === "error")
    .slice(0, 8);

  const scanJobs = stripDisks
    .filter((disk) => disk.scan.status === "running" || disk.scan.status === "paused")
    .slice(0, 4);


  const selectedFile =
    selected && "kind" in selected && selected.kind === "file" && "relativePath" in selected
      ? (selected as BrowseEntry)
      : null;
  const selectedOnline = selectedFile?.online === true;
  const selectedOnMac =
    selectedFile &&
    stripDisks.some((disk) => disk.id === selectedFile.diskId && (disk.lastHostId === "mac-mini" || disk.mountPaths.some((path) => path.startsWith("/"))));

  async function openCopyPicker() {
    if (!selectedFile) return;
    setCopyNotice(null);
    setCopyBusy(true);
    try {
      const data = await api<{ destinations: TransferDestination[] }>(`/api/files/destinations?diskId=${encodeURIComponent(selectedFile.diskId)}`);
      setDestinations(data.destinations);
      setCopyOpen(true);
    } catch (error) {
      setCopyNotice(error instanceof Error ? error.message : "Не удалось загрузить назначения");
    } finally {
      setCopyBusy(false);
    }
  }

  async function startCopy(destinationId: string) {
    if (!selectedFile) return;
    setCopyBusy(true);
    setCopyNotice(null);
    try {
      if (destinationId === "browser") {
        const url = `/api/files/download?diskId=${encodeURIComponent(selectedFile.diskId)}&path=${encodeURIComponent(selectedFile.relativePath)}`;
        window.location.href = url;
        setCopyOpen(false);
        setCopyNotice("Скачивание через браузер запущено");
        return;
      }
      const result = await api<{ job: TransferJob }>("/api/files/copy", {
        method: "POST",
        body: JSON.stringify({
          diskId: selectedFile.diskId,
          path: selectedFile.relativePath,
          destinationId,
        }),
      });
      setCopyJob(result.job);
      setCopyOpen(false);
      setCopyNotice(`Копирование · ${result.job.title}`);
      void refreshMeta();
    } catch (error) {
      setCopyNotice(error instanceof Error ? error.message : "Копирование не запустилось");
    } finally {
      setCopyBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">С</span>
          <div>
            <div className="text-sm font-semibold leading-tight">Склад</div>
            <div className="text-[11px] text-muted-foreground">файлы на дисках</div>
          </div>
          <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-seed/40 bg-seed/10 px-2 py-0.5 text-[11px] font-semibold text-seed">
            <span className="size-1.5 rounded-full bg-seed" />
            Авто
          </span>
        </div>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="sklad-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по всем дискам, включая отключённые"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setHostEditor("new")}>
          Хост
        </Button>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" />
          Торрент
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        {(data?.hosts ?? []).map((host) => (
          <button key={host.id} type="button" onClick={() => setHostEditor(host)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
            <span className={cn("size-1.5 rounded-full", host.online ? "bg-seed" : "bg-muted-foreground")} />
            {host.name}
          </button>
        ))}
        <div className="flex flex-wrap gap-1">
          {CATEGORY_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setLibFilter(chip.id)}
              className={cn(
                "rounded-full px-2 py-0.5",
                libFilter === chip.id ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[220px] shrink-0 flex-col border-r bg-card/20">
          <div className="border-b px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Диски</div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {(browse?.roots ? browse.entries : treeDisks).map((entry) => {
              const diskActive = diskId === entry.diskId;
              const open = treeOpen[entry.diskId] ?? diskActive;
              const childDirs =
                diskActive && browse && !browse.roots && !path
                  ? browse.entries.filter((item) => item.kind === "dir").slice(0, 40)
                  : [];
              return (
                <div key={entry.diskId}>
                  <button
                    type="button"
                    onClick={() => {
                      setTreeOpen((current) => ({ ...current, [entry.diskId]: true }));
                      void loadBrowse(entry.diskId, "");
                    }}
                    className={cn(
                      "flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/50",
                      diskActive && !path && "bg-muted",
                    )}
                  >
                    <span className="text-muted-foreground">{open && diskActive ? "▾" : "▸"}</span>
                    <span className={cn("size-1.5 rounded-full", entry.online ? "bg-seed" : "bg-muted-foreground")} />
                    <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title={folderHint(entry.size, entry.fileCount, entry.allocated)}>
                      {formatBytes(entry.size)}
                    </span>
                  </button>
                  {open && diskActive
                    ? childDirs.map((child) => (
                        <button
                          key={child.relativePath}
                          type="button"
                          onClick={() => void loadBrowse(child.diskId, child.relativePath)}
                          className={cn(
                            "flex w-full items-center gap-1 rounded-md py-0.5 pr-1.5 pl-6 text-left text-[11px] hover:bg-muted/50",
                            path === child.relativePath && "bg-muted",
                          )}
                        >
                          <Folder className="size-3 shrink-0 text-amber-400" />
                          <span className="min-w-0 flex-1 truncate">{child.name}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title={folderHint(child.size, child.fileCount, child.allocated)}>
                            {formatBytes(child.size)}
                          </span>
                        </button>
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={goUp} disabled={!diskId}>
              <ChevronLeft className="size-3.5" />
              Вверх
            </Button>
            <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-auto text-xs">
              {crumbs.map((crumb, index) => (
                <button
                  key={`${crumb.diskId}:${crumb.path}:${index}`}
                  type="button"
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted"
                  onClick={() => void loadBrowse(crumb.diskId, crumb.path)}
                >
                  {index > 0 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
                  <span className={cn(index === crumbs.length - 1 && "font-semibold")}>{crumb.label}</span>
                </button>
              ))}
            </nav>
            <span className="text-[11px] text-muted-foreground">
              {query.trim() ? (searching ? "поиск…" : `${rows.length}`) : browse ? `${browse.total}` : ""}
            </span>
            <select
              aria-label="Сортировка"
              className="h-7 rounded border border-input bg-transparent px-1 text-[11px]"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="size">Размер</option>
              <option value="name">Имя</option>
              <option value="type">Тип</option>
              <option value="mtime">Изменён</option>
            </select>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {browseError ? <p className="px-3 py-6 text-sm text-destructive">{browseError}</p> : null}
            <table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-background/95 text-[11px] text-muted-foreground backdrop-blur">
                <tr className="border-b">
                  <th className="px-2 py-1.5 font-medium">Имя</th>
                  <th className="w-16 px-2 py-1.5 font-medium">Тип</th>
                  <th className="w-40 px-2 py-1.5 text-right font-medium">Размер</th>
                  <th className="w-24 px-2 py-1.5 text-right font-medium">Выделено</th>
                  <th className="w-32 px-2 py-1.5 font-medium">Изменён</th>
                  <th className="px-2 py-1.5 font-medium">Путь</th>
                </tr>
              </thead>
              <tbody>
                {browseLoading && !browse ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-muted-foreground">
                      Загрузка каталога…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-muted-foreground">
                      {query.trim() ? "Ничего не найдено." : "Папка пуста в снимке каталога."}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const active =
                      selected &&
                      (("relativePath" in selected && "relativePath" in row.raw && selected.relativePath === (row.raw as BrowseEntry).relativePath && selected.diskId === (row.raw as BrowseEntry).diskId) ||
                        ("path" in selected && "path" in row.raw && (selected as SearchHit).path === (row.raw as SearchHit).path));
                    return (
                      <tr
                        key={row.key}
                        className={cn("border-b border-border/40 hover:bg-muted/30", active && "bg-muted/50")}
                        onClick={() => setSelected(row.raw as BrowseEntry)}
                        onDoubleClick={() => {
                          if ("diskId" in row.raw && "relativePath" in row.raw) openEntry(row.raw as BrowseEntry);
                        }}
                      >
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            className="flex max-w-[360px] items-center gap-1.5 truncate text-left"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (row.kind === "dir" && "diskId" in row.raw) openEntry(row.raw as BrowseEntry);
                              else setSelected(row.raw as BrowseEntry);
                            }}
                          >
                            {row.kind === "dir" ? <Folder className="size-3.5 shrink-0 text-amber-400" /> : <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                            <span className="truncate font-medium">{row.name}</span>
                          </button>
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">{row.kind === "dir" ? "папка" : row.extension || "файл"}</td>
                        <td
                          className="px-2 py-1 text-right whitespace-nowrap tabular-nums"
                          title={row.kind === "dir" && row.size != null ? folderHint(row.size, row.fileCount, row.allocated) : undefined}
                        >
                          {row.size == null ? "—" : formatSizeShare(row.size, query.trim() ? 0 : browse?.scopeBytes ?? 0)}
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums text-muted-foreground">
                          {row.allocated == null ? "—" : formatBytes(row.allocated)}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">{formatMtime(row.mtimeMs)}</td>
                        <td className="max-w-[280px] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={row.path}>
                          {row.path}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {browse?.nextCursor != null && !query.trim() ? (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadBrowse(diskId, path, browse.nextCursor ?? undefined)}
                >
                  Ещё
                </Button>
              </div>
            ) : null}
          </div>
        </main>

        <aside className="hidden w-[240px] shrink-0 flex-col border-l bg-card/20 lg:flex">
          <div className="border-b px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Сейчас</div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
            {scanJobs.map((disk) => (
              <div key={disk.id} className="rounded-md border px-2 py-1.5 text-[11px]">
                <div className="font-medium">Индекс · {displayDiskName(disk)}</div>
                <div className="text-muted-foreground">{disk.scan.message}</div>
              </div>
            ))}
            {activity.map((job) => (
              <div key={job.id} className="rounded-md border px-2 py-1.5 text-[11px]">
                <div className="font-medium">{job.title}</div>
                <div className="text-muted-foreground">{[job.diskLabel, job.host].filter(Boolean).join(" · ") || job.status}</div>
              </div>
            ))}
            {scanJobs.length === 0 && activity.length === 0 ? (
              <p className="px-1 py-3 text-[11px] text-muted-foreground">Нет активных задач.</p>
            ) : null}
          </div>
          {selected && "displayPath" in selected ? (
            <div className="border-t p-2 text-[11px]">
              <div className="font-medium">{selected.name}</div>
              <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{selected.displayPath}</div>
              {"size" in selected ? (
                <div className="mt-1 space-y-0.5 text-muted-foreground">
                  <div>{formatBytes(selected.size)}</div>
                  {selected.allocated != null ? <div>Выделено {formatBytes(selected.allocated)}</div> : null}
                  {selected.kind === "dir" ? <div>{selected.fileCount.toLocaleString("ru-RU")} файлов</div> : null}
                </div>
              ) : null}
              {selectedFile ? (
                <div className="mt-2 space-y-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 w-full text-xs font-semibold"
                    disabled={!selectedOnline || copyBusy}
                    title={selectedOnline ? "Скопировать файл на другой диск или в Загрузки" : "Нужен подключённый диск"}
                    onClick={() => void openCopyPicker()}
                  >
                    {selectedOnline ? "Копировать" : "Нужен подключённый диск"}
                  </Button>
                  {copyNotice ? <p className="text-[10px] text-muted-foreground">{copyNotice}</p> : null}
                  {copyJob ? (
                    <p className="text-[10px] text-muted-foreground">
                      {copyJob.status === "completed" && copyJob.verified
                        ? `Готово · SHA совпал · ${copyJob.destPath || ""}`
                        : copyJob.status === "error"
                          ? copyJob.error
                          : `${copyJob.status} · ${formatBytes(copyJob.bytesDone)}${copyJob.bytesTotal ? ` / ${formatBytes(copyJob.bytesTotal)}` : ""}`}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="flex gap-1 overflow-auto border-t px-2 py-1 text-[11px]">
        {stripDisks.map((disk) => (
          <button
            key={disk.id}
            type="button"
            onClick={() => openDisk(disk)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 hover:bg-muted/40",
              diskId === disk.id && "border-primary bg-primary/10",
            )}
            title={disk.mountPaths[0] || disk.lastMountPath}
          >
            <span className={cn("size-1.5 rounded-full", disk.online ? "bg-seed" : "bg-muted-foreground")} />
            <span className="font-medium">{displayDiskTitle(disk)}</span>
            <span className="text-muted-foreground">
              {formatBytes(disk.freeBytes)} / {formatBytes(disk.totalBytes)}
            </span>
          </button>
        ))}
      </footer>


      {copyOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Куда копировать">
          <div className="w-full max-w-md rounded-lg border bg-background shadow-xl">
            <div className="border-b px-3 py-2">
              <div className="text-sm font-semibold">Куда копировать</div>
              <div className="truncate text-[11px] text-muted-foreground">{selectedFile?.name}</div>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-auto p-3">
              {["Этот браузер", "Mac mini", "Windows PC"].map((group) => {
                const items = destinations.filter((item) => {
                  if (group === "Этот браузер") return item.hostName === "Этот браузер";
                  if (group === "Mac mini") return item.hostName === "Mac mini" || item.hostId === "mac-mini";
                  return item.hostName.toLowerCase().includes("windows") || item.hostId === "windows-pc";
                });
                if (!items.length) return null;
                return (
                  <div key={group}>
                    <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{group}</div>
                    <div className="space-y-1">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          disabled={!item.online || copyBusy}
                          onClick={() => void startCopy(item.id)}
                          className="flex w-full flex-col rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted/50 disabled:opacity-50"
                        >
                          <span className="font-medium">{item.label}</span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">{item.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 border-t px-3 py-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setCopyOpen(false)}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <AddTorrentDialog
        open={addOpen}
        hosts={data?.hosts ?? []}
        defaultHostId={data?.hosts.find((host) => host.online)?.id ?? data?.hosts[0]?.id ?? ""}
        onClose={() => setAddOpen(false)}
        onAdded={() => void refreshMeta()}
      />
      <HostDialog
        open={hostEditor !== null}
        host={hostEditor && hostEditor !== "new" ? hostEditor : null}
        onClose={() => setHostEditor(null)}
        onSaved={() => void refreshMeta()}
      />
    </div>
  );
}
