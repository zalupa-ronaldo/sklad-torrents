"use client";

import { HardDrive } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { DEMO_DISKS, DEMO_FILES, DISK_PAGE_SIZE, FILE_PAGE_SIZE, JOB_PAGE_SIZE, pageSlice, type DemoDisk, type DemoFile } from "@/lib/jobs/demo-catalog";
import { HOST_LABEL, KIND_LABEL, STATE_LABEL, STATE_TONE } from "@/lib/jobs/labels";
import type { EnqueueInput, JobCounts, JobEvent, PublicJob, PublicJobList } from "@/lib/jobs/model";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";

const EMPTY_COUNTS: JobCounts = { queued: 0, running: 0, paused: 0, done: 0, error: 0 };

export function ProgressBoard() {
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [games, setGames] = useState<{ id: string; name: string; state: string; online: boolean; ready: boolean; location: string }[]>([]);
  const [counts, setCounts] = useState<JobCounts>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [fileQuery, setFileQuery] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [diskPage, setDiskPage] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string>(DEMO_FILES[0]?.id ?? "");
  const [selectedDisk, setSelectedDisk] = useState<string>(DEMO_DISKS[1]?.id ?? "");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const [seenQuery, setSeenQuery] = useState(query);
  if (query !== seenQuery) {
    setSeenQuery(query);
    setOffset(0);
  }

  const load = useCallback(async () => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(JOB_PAGE_SIZE) });
    if (query.trim()) params.set("q", query.trim());
    const page = await api<PublicJobList & { games?: { id: string; name: string; state: string; online: boolean; ready: boolean; location: string }[] }>(`/api/jobs?${params}`);
    setJobs(page.jobs);
    setGames(page.games ?? []);
    setTotal(page.total);
    setCounts(page.counts);
    setLoadError(null);
  }, [offset, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const kick = window.setTimeout(() => {
      void load().catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Очередь не загрузилась");
      });
    }, 0);
    return () => window.clearTimeout(kick);
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let poll: number | null = null;
    let reconnect: number | null = null;

    const stopPoll = () => {
      if (poll) window.clearInterval(poll);
      poll = null;
    };

    const apply = (event: JobEvent) => {
      if (event.type === "snapshot") {
        setCounts(event.counts);
        return;
      }
      setCounts(event.counts);
      setJobs((current) => {
        const index = current.findIndex((job) => job.id === event.job.id);
        if (index === -1) return current;
        const next = current.slice();
        next[index] = event.job;
        return next;
      });
    };

    const connect = () => {
      if (closed) return;
      source?.close();
      source = new EventSource("/api/jobs/events");
      source.onopen = () => {
        if (closed) return;
        setLive(true);
        stopPoll();
      };
      const onEvent = (message: MessageEvent<string>) => {
        try {
          apply(JSON.parse(message.data) as JobEvent);
        } catch {
          // Ignore a broken keepalive frame.
        }
      };
      source.addEventListener("snapshot", onEvent);
      source.addEventListener("upsert", onEvent);
      source.addEventListener("progress", onEvent);
      source.onerror = () => {
        if (closed) return;
        setLive(false);
        source?.close();
        if (!poll) {
          poll = window.setInterval(() => {
            void loadRef.current().catch(() => undefined);
          }, 3000);
        }
        reconnect = window.setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      stopPoll();
      if (reconnect) window.clearTimeout(reconnect);
    };
  }, []);

  const remember = useCallback((job: PublicJob, created: boolean) => {
    setJobs((current) => {
      if (current.some((item) => item.id === job.id)) {
        return current.map((item) => (item.id === job.id ? job : item));
      }
      return [job, ...current].slice(0, JOB_PAGE_SIZE);
    });
    if (created && !query.trim()) setTotal((value) => value + 1);
  }, [query]);

  const enqueue = useCallback(
    async (input: EnqueueInput) => {
      setPosting(true);
      try {
        const result = await api<{ job: PublicJob; created: boolean }>("/api/jobs", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (offset !== 0) setOffset(0);
        else remember(result.job, result.created);
        toast.success(result.created ? "В очереди" : "Уже в очереди");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Не удалось поставить в очередь");
      } finally {
        setPosting(false);
      }
    },
    [offset, remember],
  );

  const filteredFiles = useMemo(() => {
    const needle = fileQuery.trim().toLowerCase();
    if (!needle) return DEMO_FILES;
    return DEMO_FILES.filter((file) => `${file.name} ${file.path} ${HOST_LABEL[file.host]}`.toLowerCase().includes(needle));
  }, [fileQuery]);
  const fileWindow = pageSlice(filteredFiles, filePage, FILE_PAGE_SIZE);
  const diskWindow = pageSlice(DEMO_DISKS, diskPage, DISK_PAGE_SIZE);
  const file = DEMO_FILES.find((item) => item.id === selectedFile) ?? null;
  const disk = DEMO_DISKS.find((item) => item.id === selectedDisk) ?? null;
  const jobPages = Math.max(1, Math.ceil(total / JOB_PAGE_SIZE));
  const jobPage = Math.floor(offset / JOB_PAGE_SIZE);

  function moveInput(source: DemoFile, destination: DemoDisk): EnqueueInput | null {
    if (source.host !== destination.host) return null;
    return {
      kind: "move",
      host: source.host,
      source: source.path,
      destination: joinPath(destination, source.name),
      diskId: destination.id,
    };
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Очередь</h1>
            <p className="text-xs text-muted-foreground">
              {live ? "Прогресс по потоку" : "Поток оборвался, обновляем опросом"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Count label="В очереди" value={counts.queued} />
          <Count label="Выполняется" value={counts.running} />
          <Count label="Пауза" value={counts.paused} />
          <Count label="Завершено" value={counts.done} />
          <Count label="Ошибка" value={counts.error} />
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Раздачи
          </Link>
        </div>
      </header>
      {games.length > 0 ? (
        <ul className="flex gap-2 overflow-auto border-b px-4 py-2">
          {games.map((game) => (
            <li key={game.id} className="rounded-md border px-2 py-1 text-xs">
              <span className="font-medium">{game.name}</span>
              <span className="ml-2 text-muted-foreground">{game.online ? "на месте" : "offline"} · {game.ready ? "готова" : game.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="flex min-h-0 flex-col gap-4 overflow-auto border-b px-4 py-4 lg:border-r lg:border-b-0">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Файлы</h2>
                <Input
                  value={fileQuery}
                  onChange={(event) => {
                    setFileQuery(event.target.value);
                    setFilePage(0);
                  }}
                  placeholder="Поиск"
                  aria-label="Поиск файлов"
                  className="h-7 max-w-40 text-xs"
                />
              </div>
              <ul className="grid gap-1.5">
                {fileWindow.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", JSON.stringify({ id: item.id }));
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => setSelectedFile(item.id)}
                      className={cn(
                        "w-full rounded-lg border px-2.5 py-2 text-left",
                        selectedFile === item.id ? "border-primary bg-primary/10" : "border-border",
                      )}
                    >
                      <span className="block truncate text-sm">{item.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {HOST_LABEL[item.host]} · {item.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Pager
                page={fileWindow.page}
                pages={fileWindow.pages}
                label={`${filteredFiles.length === 0 ? 0 : fileWindow.page * FILE_PAGE_SIZE + 1}–${fileWindow.page * FILE_PAGE_SIZE + fileWindow.items.length} из ${filteredFiles.length}`}
                onPage={setFilePage}
              />
            </div>
            <div className="grid content-start gap-2">
              <h2 className="text-sm font-medium">Куда положить</h2>
              <ul className="grid gap-1.5">
                {diskWindow.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedDisk(item.id)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOver(item.id);
                      }}
                      onDragLeave={() => setDragOver((current) => (current === item.id ? null : current))}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOver(null);
                        const dropped = readDragged(event.dataTransfer.getData("text/plain"));
                        if (!dropped) return;
                        const input = moveInput(dropped, item);
                        if (!input) {
                          toast.error("Перенос только внутри одного компьютера");
                          return;
                        }
                        void enqueue(input);
                      }}
                      className={cn(
                        "w-full rounded-lg border px-2.5 py-2 text-left",
                        dragOver === item.id ? "border-primary bg-primary/15" : selectedDisk === item.id ? "border-primary/70" : "border-border",
                      )}
                    >
                      <span className="block text-sm">{item.label}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {HOST_LABEL[item.host]} · {item.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Pager
                page={diskWindow.page}
                pages={diskWindow.pages}
                label={`Диски ${diskWindow.page * DISK_PAGE_SIZE + 1}–${diskWindow.page * DISK_PAGE_SIZE + diskWindow.items.length} из ${DEMO_DISKS.length}`}
                onPage={setDiskPage}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={posting || !file || !disk} onClick={() => file && disk && void enqueueMove(file, disk, enqueue)}>
              Поставить в очередь
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={posting || file?.host !== "mac-local"}
              onClick={() => file && void enqueue(transcodeInput(file))}
            >
              В очередь: перекодировать
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={posting || file?.host !== "pc-agent"}
              onClick={() => file && void enqueue(compactInput(file))}
            >
              В очередь: сжать NTFS
            </Button>
            <Button type="button" variant="outline" disabled={posting || !disk} onClick={() => disk && void enqueue(indexInput(disk))}>
              В очередь: индекс
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Кнопка только записывает задачу. Mac и Windows забирают свою очередь сами. В демо прогресс имитируется и диск не трогается. Исходник не удаляется, пока результат не проверен и вы отдельно это не подтвердите.
          </p>
        </section>
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Поиск задач"
              aria-label="Поиск задач"
              className="h-8 text-sm"
            />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{total}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {loadError ? <p className="mb-3 text-sm text-destructive">{loadError}</p> : null}
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Пока пусто. Перетащите файл на диск или нажмите «Поставить в очередь».</p>
            ) : (
              <ul className="grid gap-2">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} onChanged={remember} />
                ))}
              </ul>
            )}
          </div>
          <div className="border-t px-4 py-2">
            <Pager
              page={jobPage}
              pages={jobPages}
              label={total === 0 ? "Нет задач" : `${offset + 1}–${offset + jobs.length} из ${total}`}
              onPage={(page) => setOffset(page * JOB_PAGE_SIZE)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function JobRow({ job, onChanged }: { job: PublicJob; onChanged: (job: PublicJob, created: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  async function act(path: string) {
    setBusy(true);
    try {
      const result = await api<{ job: PublicJob }>(path, { method: "POST" });
      onChanged(result.job, false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  const canPause = job.state === "queued" || job.state === "running";
  const canConfirm = (job.kind === "move" || job.kind === "copy") && job.state === "done" && job.verified && !job.sourceDeleted;

  return (
    <li className="rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium", STATE_TONE[job.state])}>
          {STATE_LABEL[job.state]}
        </span>
        <span className="text-sm font-medium">{KIND_LABEL[job.kind]}</span>
        <span className="text-xs text-muted-foreground">{HOST_LABEL[job.host]}</span>
        {job.verified ? <span className="text-[11px] text-seed">проверено</span> : null}
        {job.sourceDeleted ? <span className="text-[11px] text-warn">исходник помечен удалённым</span> : null}
      </div>
      <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
        {job.payload.source || job.payload.diskId}
        {job.payload.destination ? ` → ${job.payload.destination}` : ""}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-download" style={{ width: `${Math.min(100, job.progress.percent)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {job.progress.percent}% · {formatBytes(job.progress.processedBytes)} из {formatBytes(job.progress.totalBytes)}
        {job.progress.speed > 0 ? ` · ${formatSpeed(job.progress.speed)}` : ""}
        {job.progress.etaSeconds !== null ? ` · ${formatEta(job.progress.etaSeconds)}` : ""}
        {job.progress.currentFile ? ` · ${job.progress.currentFile}` : ""}
      </p>
      {job.payload.handbrakeProfile ? <p className="text-[11px] text-muted-foreground">HandBrake: {job.payload.handbrakeProfile}</p> : null}
      {job.payload.compactAlgorithm ? <p className="text-[11px] text-muted-foreground">Алгоритм: {job.payload.compactAlgorithm}</p> : null}
      {job.lastError ? <p className="mt-1 text-xs text-destructive">{job.lastError}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canPause ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void act(`/api/jobs/${job.id}/pause`)}>
            Пауза
          </Button>
        ) : null}
        {job.state === "paused" ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void act(`/api/jobs/${job.id}/resume`)}>
            Продолжить
          </Button>
        ) : null}
        {canPause || job.state === "paused" ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void act(`/api/jobs/${job.id}/cancel`)}>
            Отменить
          </Button>
        ) : null}
        {job.state === "error" && !job.sourceDeleted ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void act(`/api/jobs/${job.id}/retry`)}>
            Повторить
          </Button>
        ) : null}
        {canConfirm ? (
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void act(`/api/jobs/${job.id}/confirm-source-delete`)}>
            Подтвердить удаление исходника
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground tabular-nums">
      {label} <span className="text-foreground">{value}</span>
    </span>
  );
}

function Pager({ page, pages, label, onPage }: { page: number; pages: number; label: string; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        <Button type="button" size="xs" variant="outline" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          Назад
        </Button>
        <span className="px-1 tabular-nums">
          {page + 1}/{pages}
        </span>
        <Button type="button" size="xs" variant="outline" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          Дальше
        </Button>
      </div>
    </div>
  );
}

function enqueueMove(file: DemoFile, disk: DemoDisk, enqueue: (input: EnqueueInput) => Promise<void>) {
  if (file.host !== disk.host) {
    toast.error("Перенос только внутри одного компьютера");
    return;
  }
  return enqueue({
    kind: "move",
    host: file.host,
    source: file.path,
    destination: joinPath(disk, file.name),
    diskId: disk.id,
  });
}

function transcodeInput(file: DemoFile): EnqueueInput {
  const destination = file.path.replace(/\.[^./\\]+$/, "") + ".1080p.mp4";
  return {
    kind: "transcode",
    host: file.host,
    source: file.path,
    destination,
    diskId: file.diskId,
    handbrakeProfile: "Apple 1080p30",
  };
}

function compactInput(file: DemoFile): EnqueueInput {
  return {
    kind: "compact",
    host: file.host,
    source: file.path,
    destination: file.path,
    diskId: file.diskId,
    compactAlgorithm: "XPRESS16K",
  };
}

function indexInput(disk: DemoDisk): EnqueueInput {
  return { kind: "index", host: disk.host, source: disk.path, diskId: disk.id };
}

function joinPath(disk: DemoDisk, name: string): string {
  if (disk.host === "pc-agent") return `${disk.path}\\${name}`;
  return `${disk.path}/${name}`;
}

function readDragged(raw: string): DemoFile | null {
  try {
    const parsed = JSON.parse(raw) as { id?: string };
    return DEMO_FILES.find((file) => file.id === parsed.id) ?? null;
  } catch {
    return null;
  }
}
