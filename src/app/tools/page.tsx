"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { formatArgv } from "@/addons/media-games/paths";
import { JOB_KIND_LABEL, JOB_STATE_LABEL, LIBRARY_STATUS_LABEL, RUNNER_LABEL, hostTitle } from "@/addons/media-games/labels";
import type { JobKind, JobRecord } from "@/addons/media-games/types";
import { Meter, Status } from "@/app/tools/shell";
import { useToolsSnapshot } from "@/app/tools/use-tools";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import { formatBytes, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const FILTERS: { id: "all" | JobKind; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "transcode", label: "Перекодирование" },
  { id: "move", label: "Перенос" },
  { id: "compress", label: "Сжатие" },
];

export default function ToolsPage() {
  const { data, error, loading, refresh } = useToolsSnapshot(true);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(id: string, action: "keep-source" | "delete-source") {
    setBusy(id);
    try {
      await api(`/api/tools/jobs/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      toast.success(action === "delete-source" ? "Удаление источника подтверждено" : "Источник оставлен на месте");
      setArmed(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-28 animate-pulse rounded-lg bg-muted/70" />
        <p className="text-sm text-muted-foreground">Загружаем очередь…</p>
      </div>
    );
  }
  if (error && !data) {
    return (
      <Status
        title="Очередь не загрузилась"
        body={error}
        action={<Button onClick={() => void refresh()}>Повторить</Button>}
      />
    );
  }
  if (!data) return null;

  const jobs = data.jobs.filter((job) => filter === "all" || job.kind === filter);
  const mac = data.probes.find((probe) => probe.id === "mac-local");
  const pc = data.probes.find((probe) => probe.id === "pc-agent");

  return (
    <div className="grid gap-6">
      <section className="rounded-xl border bg-card px-4 py-3 text-sm">
        <p>
          {data.config.demoMode
            ? "Демо-режим: задания идут по очереди, HandBrake и compact.exe не запускаются."
            : "Демо выключен: Mac выполняет команды локально, Windows — через агент."}
        </p>
        <p className="mt-1 text-muted-foreground">
          Mac: {mac?.handbrakeFound ? "HandBrakeCLI найден" : "HandBrakeCLI не найден"}. Windows:{" "}
          {pc?.handbrakeFound ? "HandBrakeCLI найден" : "HandBrakeCLI не найден"}. Сжатие NTFS:{" "}
          {pc?.compactAvailable ? (pc.compactFound ? "compact.exe найден" : "compact.exe не найден, в демо есть оценка") : "недоступно"}.
        </p>
        {error ? <p className="mt-2 text-warn">Список мог устареть: {error}</p> : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs",
              filter === item.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{jobs.length}</span>
      </div>

      {jobs.length === 0 ? (
        <Status
          title={filter === "all" ? "Очередь пуста" : "В этом виде пусто"}
          body="Поставьте ролик в HandBrake или перенесите папку игры с HDD на SSD. Исходник не удаляется, пока копия не проверена и вы сами это не подтвердите."
          action={
            <div className="flex flex-wrap gap-2">
              <Link href="/tools/transcode" className={buttonVariants()}>
                Перекодировать
              </Link>
              <Link href="/tools/move" className={buttonVariants({ variant: "outline" })}>
                Перенос игры
              </Link>
            </div>
          }
        />
      ) : (
        <ul className="grid gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="rounded-xl border bg-card px-4 py-3">
              <JobCard
                job={job}
                hostName={hostTitle(job.hostId, data.config.hosts.find((host) => host.id === job.hostId)?.name)}
                armed={armed === job.id}
                busy={busy === job.id}
                onArm={(checked) => setArmed(checked ? job.id : null)}
                onResolve={(action) => void resolve(job.id, action)}
              />
            </li>
          ))}
        </ul>
      )}

      <section className="grid gap-3">
        <h2 className="text-sm font-medium">Библиотека</h2>
        {data.library.length === 0 ? (
          <p className="text-sm text-muted-foreground">После проверенного переноса здесь появится новая папка игры.</p>
        ) : (
          <ul className="grid gap-2">
            {data.library.map((item) => (
              <li key={item.id} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{LIBRARY_STATUS_LABEL[item.status]}</p>
                </div>
                <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{item.oldPath}</p>
                <p className="font-mono text-[11px] break-all">→ {item.newPath}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function JobCard({
  job,
  hostName,
  armed,
  busy,
  onArm,
  onResolve,
}: {
  job: JobRecord;
  hostName: string;
  armed: boolean;
  busy: boolean;
  onArm: (checked: boolean) => void;
  onResolve: (action: "keep-source" | "delete-source") => void;
}) {
  const output = job.outputPath || job.destinationPath || job.folderPath;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium break-all">{job.title}</p>
          <p className="text-xs text-muted-foreground">
            {JOB_KIND_LABEL[job.kind]} · {hostName} · {RUNNER_LABEL[job.runner]} · {JOB_STATE_LABEL[job.state]}
          </p>
        </div>
        <span className="text-xs tabular-nums">{formatPercent(job.progress)}</span>
      </div>
      <Meter value={job.progress} />
      {output ? <p className="font-mono text-[11px] break-all text-muted-foreground">{output}</p> : null}
      {job.outputMarker ? <p className="text-xs text-muted-foreground">Маркер: {job.outputMarker}</p> : null}
      {job.bytesBefore != null && job.bytesAfter != null ? (
        <p className="text-sm">
          Было {formatBytes(job.bytesBefore)}, стало {formatBytes(job.bytesAfter)} (минус{" "}
          {job.bytesBefore > 0 ? Math.round(((job.bytesBefore - job.bytesAfter) / job.bytesBefore) * 100) : 0}%).
          {job.runner === "mock" ? " Оценка демо, compact.exe не запускался." : ""}
        </p>
      ) : null}
      {job.error ? <p className="text-sm text-destructive">{job.error}</p> : null}
      {job.kind === "move" && job.state !== "failed" ? (
        <p className="text-xs text-muted-foreground">
          {job.sourceDeleted
            ? job.runner === "mock"
              ? "Демо: файлы на диске не трогались. В журнале удаление подтверждено, библиотека смотрит на новую папку."
              : "Исходная папка удалена после проверки и подтверждения."
            : "Исходная папка на месте. Удаление возможно только после проверки и отдельного подтверждения."}
        </p>
      ) : null}
      {job.verify ? (
        <p className="text-xs text-muted-foreground">
          {job.verify.message} Файлов {job.verify.destFiles} из {job.verify.sourceFiles}, хеш {job.verify.ok ? "совпал" : "не совпал"}.
        </p>
      ) : null}
      {job.state === "awaiting-confirm" ? (
        <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-3">
          <p className="text-sm">Копия проверена. Источник не удалится, пока не отметите подтверждение.</p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={armed} onCheckedChange={(value) => onArm(value === true)} />
            Удалить исходную папку
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve("keep-source")}>
              Оставить источник
            </Button>
            <Button size="sm" variant="destructive" disabled={busy || !armed} onClick={() => onResolve("delete-source")}>
              Удалить исходную папку
            </Button>
          </div>
          {job.hostId === "pc-agent" && job.destinationPath ? (
            <Link
              href={`/tools/compress?host=pc-agent&os=win32&path=${encodeURIComponent(job.destinationPath)}`}
              className="text-sm text-primary hover:underline"
            >
              Сжать папку назначения
            </Link>
          ) : null}
        </div>
      ) : null}
      {job.plannedArgv.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Команда</summary>
          <p className="mt-1 font-mono break-all">{formatArgv(job.plannedArgv)}</p>
        </details>
      ) : null}
    </div>
  );
}
