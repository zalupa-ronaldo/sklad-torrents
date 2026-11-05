"use client";

import { Copy, FolderInput, Pause, Play, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { handbrakeHref, moveGameHref, torrentReadyForMedia } from "@/addons/media-games/links";
import { TorrentHashes } from "@/components/torrent-hashes";
import { TorrentPlacementCard } from "@/components/torrent-placement";
import { ProgressBar, ProgressLabel } from "@/components/progress-bar";
import { StateBadge } from "@/components/state-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { formatBytes, formatEta, formatRatio, formatSpeed, formatTimestamp } from "@/lib/format";
import { torrentJobId } from "@/lib/progress/ids";
import { priorityLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { PathPreset, TorrentDetailPayload, TorrentFileView } from "@/lib/qbittorrent/types";

const fieldClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function TorrentDetail({
  detail,
  loading,
  error,
  presets,
  onClose,
  onChanged,
}: {
  detail: TorrentDetailPayload | null;
  loading: boolean;
  error: string | null;
  presets: PathPreset[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);

  const torrent = detail?.torrent;

  async function act(pathBody: unknown, success: string): Promise<boolean> {
    if (!torrent) return false;
    setBusy(true);
    try {
      const result = await api<{ skipped?: number; notice?: string }>(`/api/torrents/${torrent.hostId}/${torrent.hash}`, {
        method: "POST",
        body: JSON.stringify(pathBody),
      });
      if (typeof result.skipped === "number") {
        toast.success(result.skipped === 0 ? "Все выбранные файлы уже целые" : `Не скачивать: ${result.skipped}`);
      } else if (result.notice) {
        toast.message(result.notice);
      } else {
        toast.success(success);
      }
      onChanged();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function enqueueMove() {
    if (!torrent || !destination.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ created: boolean }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          kind: "move",
          host: torrent.hostOs === "win32" ? "pc-agent" : "mac-local",
          source: torrent.contentPath || torrent.savePath,
          destination: destination.trim(),
          diskId: torrent.hostId,
          torrentHash: torrent.hash,
        }),
      });
      toast.success(result.created ? "В очереди" : "Уже в очереди");
      setMoveOpen(false);
      router.push("/progress");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось поставить в очередь");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Путь скопирован");
    } catch {
      toast.error("Браузер не дал скопировать путь");
    }
  }

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-background lg:static lg:z-auto lg:w-[440px] lg:shrink-0 lg:border-l lg:bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Где лежит</p>
          <h2 className="truncate text-base font-semibold">{torrent?.name ?? "Раздача"}</h2>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Закрыть карточку" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && !torrent ? <p className="text-sm text-muted-foreground">Загружаем файлы…</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {torrent && detail ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge state={torrent.state} rawState={torrent.rawState} />
              <span className="text-xs text-muted-foreground">{torrent.hostName}</span>
              <Link
                href={`/progress/${encodeURIComponent(torrentJobId(torrent.hostId, torrent.hash))}`}
                className="text-xs text-primary hover:underline"
              >
                Прогресс
              </Link>
              {torrent.moveMark ? <span className="text-xs text-warn">к переносу</span> : null}
            </div>
            <TorrentPlacementCard hostId={torrent.hostId} hash={torrent.hash} onChanged={onChanged} />
            <div>
              <div className="mb-1 flex items-center justify-between text-sm tabular-nums">
                <ProgressLabel value={torrent.progress} />
                <span className="text-muted-foreground">{formatBytes(torrent.downloaded)} из {formatBytes(torrent.size)}</span>
              </div>
              <ProgressBar value={torrent.progress} state={torrent.state} className="h-2" />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <Stat label="Скачивание" value={formatSpeed(torrent.dlspeed)} />
              <Stat label="Раздача" value={formatSpeed(torrent.upspeed)} />
              <Stat label="Осталось" value={formatEta(torrent.eta)} />
              <Stat label="Рейтинг" value={formatRatio(torrent.ratio)} />
              <Stat label="Сиды" value={String(torrent.numSeeds)} />
              <Stat label="Личи" value={String(torrent.numLeechs)} />
              <Stat label="Добавлено" value={formatTimestamp(torrent.addedOn)} />
              <Stat label="Завершено" value={formatTimestamp(torrent.completionOn)} />
            </dl>
            <PathBlock label="Каталог сохранения" path={torrent.savePath} onCopy={() => void copy(torrent.savePath)} />
            <PathBlock label="Корень раздачи" path={torrent.contentPath} onCopy={() => void copy(torrent.contentPath)} />
            {torrent.totalSize > torrent.size ? (
              <p className="text-xs text-muted-foreground">
                В раздаче всего {formatBytes(torrent.totalSize)}, к загрузке выбрано {formatBytes(torrent.size)}.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {torrent.state === "paused" ? (
                <Button size="sm" disabled={busy} onClick={() => void act({ action: "resume" }, "Раздача продолжена")}>
                  <Play />
                  Продолжить
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "pause" }, "На паузе")}>
                  <Pause />
                  Пауза
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDestination(torrent.moveMark?.destination ?? "");
                  setMoveOpen(true);
                }}
              >
                <FolderInput />
                Перенести
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setDeleteFiles(false);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 />
                Удалить
              </Button>
            </div>
            {torrentReadyForMedia(torrent.progress, detail.files) ? (
              <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  Файлы на месте. HandBrake и перенос папки открываются отдельно, таблица раздач их не содержит.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={handbrakeHref({ os: torrent.hostOs, path: torrent.contentPath, name: torrent.name })}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    В HandBrake
                  </Link>
                  <Link
                    href={moveGameHref({ os: torrent.hostOs, path: torrent.contentPath, name: torrent.name })}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Перенести или сжать папку
                  </Link>
                </div>
              </div>
            ) : null}
            <TorrentHashes
              hostId={torrent.hostId}
              hash={torrent.hash}
              name={torrent.name}
              complete={torrent.progress >= 0.999 && torrent.state !== "moving" && torrent.state !== "checking"}
            />
            <FileList
              files={detail.files}
              busy={busy}
              onPriority={(ids, priority) => void act({ action: "priority", ids, priority }, "Приоритет обновлён")}
              onSkip={() => void act({ action: "skip-incomplete" }, "")}
              onCopy={(path) => void copy(path)}
            />
          </div>
        ) : null}
      </div>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Перенести на этом же хосте</DialogTitle>
            <DialogDescription>
              Кнопка только ставит перенос в очередь. Воркер на этом компьютере заберёт задачу сам, окно не ждёт копирования.
              Исходник удаляется отдельно, после проверки результата.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setDestination(preset.path)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    destination === preset.path ? "border-primary bg-primary/15" : "border-border text-muted-foreground",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={torrent?.hostOs === "win32" ? "E:\\Cinema" : "/Volumes/vault/Cinema/Watched"}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy || !destination.trim()}
              onClick={() =>
                void act({ action: "mark", destination }, "Отмечено к переносу").then((ok) => ok && setMoveOpen(false))
              }
            >
              Только отметить
            </Button>
            <Button disabled={busy || !destination.trim()} onClick={() => void enqueueMove()}>
              Поставить в очередь
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить раздачу?</DialogTitle>
            <DialogDescription>«{torrent?.name}» пропадёт из qBittorrent на {torrent?.hostName}.</DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={deleteFiles} onCheckedChange={setDeleteFiles} />
            Также удалить файлы с диска
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void act(
                  { action: "delete", deleteFiles },
                  deleteFiles ? "Раздача и файлы удалены" : "Раздача удалена, файлы на диске",
                ).then((ok) => {
                  if (!ok) return;
                  setDeleteOpen(false);
                  onClose();
                })
              }
            >
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function FileList({
  files,
  busy,
  onPriority,
  onSkip,
  onCopy,
}: {
  files: TorrentFileView[];
  busy: boolean;
  onPriority: (ids: number[], priority: number) => void;
  onSkip: () => void;
  onCopy: (path: string) => void;
}) {
  const [fileQuery, setFileQuery] = useState("");
  const [filePage, setFilePage] = useState(0);
  const complete = files.filter((file) => file.progress >= 0.999).length;
  const skipped = files.filter((file) => file.priority === 0).length;
  const incomplete = files.some((file) => file.priority > 0 && file.progress < 0.999);
  const needle = fileQuery.trim().toLowerCase();
  const filtered = needle
    ? files.filter((file) => `${file.name}\n${file.absolutePath}`.toLowerCase().includes(needle))
    : files;
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(filePage, pages - 1);
  const visible = filtered.slice(page * pageSize, page * pageSize + pageSize);
  return (
    <section className="grid gap-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Файлы</h3>
          <p className="text-xs text-muted-foreground">
            {complete} из {files.length} целиком{skipped ? ` · ${skipped} не скачиваются` : ""}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy || !incomplete} onClick={onSkip}>
          Оставить только целые
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Недокачанным ставится приоритет «не скачивать». Целые файлы qBittorrent не трогает, раздача по ним продолжается.
      </p>
      <Input
        value={fileQuery}
        onChange={(event) => {
          setFileQuery(event.target.value);
          setFilePage(0);
        }}
        placeholder="Поиск по файлам"
        aria-label="Поиск по файлам"
        className="h-8 text-xs"
      />
      <ul className="grid gap-2">
        {visible.map((file) => (
          <li key={file.index} className="rounded-lg border px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-sm break-all">{fileLeaf(file.name)}</p>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar value={file.progress} state={file.priority === 0 ? "paused" : file.progress >= 0.999 ? "seeding" : "downloading"} />
              <span className="w-12 shrink-0 text-right text-xs tabular-nums">
                <ProgressLabel value={file.progress} />
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <select
                aria-label={`Приоритет ${fileLeaf(file.name)}`}
                className={fieldClass}
                disabled={busy}
                value={selectPriority(file.priority)}
                onChange={(event) => onPriority([file.index], Number(event.target.value))}
              >
                <option value={0}>Не скачивать</option>
                <option value={1}>Обычный</option>
                <option value={6}>Высокий</option>
                <option value={7}>Максимальный</option>
              </select>
              <Button variant="ghost" size="icon-sm" aria-label="Скопировать путь" onClick={() => onCopy(file.absolutePath)}>
                <Copy />
              </Button>
            </div>
            <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground" title={file.absolutePath}>
              {file.absolutePath}
            </p>
            {file.priority !== selectPriority(file.priority) ? (
              <p className="mt-1 text-[11px] text-muted-foreground">Сейчас: {priorityLabel(file.priority)}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {filtered.length > pageSize ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {page * pageSize + 1}–{page * pageSize + visible.length} из {filtered.length}
          </span>
          <span className="flex gap-1">
            <Button type="button" size="xs" variant="outline" disabled={page <= 0} onClick={() => setFilePage(page - 1)}>
              Назад
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={page + 1 >= pages} onClick={() => setFilePage(page + 1)}>
              Дальше
            </Button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function PathBlock({ label, path, onCopy }: { label: string; path: string; onCopy: () => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Button variant="ghost" size="icon-xs" aria-label={`Скопировать: ${label}`} onClick={onCopy}>
          <Copy />
        </Button>
      </div>
      <p className="rounded-lg border bg-muted/30 px-2.5 py-2 font-mono text-xs break-all">{path}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function fileLeaf(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] || name;
}

function selectPriority(priority: number): number {
  if (priority <= 0) return 0;
  if (priority === 1) return 1;
  if (priority >= 7) return 7;
  return 6;
}
