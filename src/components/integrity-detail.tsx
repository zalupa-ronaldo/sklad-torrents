"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";
import { HASH_STATUS_LABEL, type HashFileRecord, type IntegrityJob } from "@/lib/integrity/types";

export function IntegrityDetail({ id }: { id: string }) {
  const [job, setJob] = useState<IntegrityJob | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api<{ job: IntegrityJob }>(`/api/integrity/${encodeURIComponent(id)}`);
      setJob(payload.job);
      setConfirmed((current) => payload.job.userConfirmed || current);
      setMissing(false);
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Не удалось открыть задачу";
      if (message.includes("не найдена")) setMissing(true);
      setError(message);
    }
  }, [id]);

  useEffect(() => {
    const kick = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 1000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [load]);

  async function cancel() {
    setBusy(true);
    try {
      const payload = await api<{ job: IntegrityJob }>(`/api/integrity/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      setJob(payload.job);
      toast.success("Остановлено. Файлы не удалялись.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось отменить");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const payload = await api<{ job: IntegrityJob; deletedFiles: boolean }>(`/api/integrity/${encodeURIComponent(id)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      });
      setJob(payload.job);
      toast.success(payload.deletedFiles ? "Файлы удалены" : "Подтверждение записано. Файлы не удалялись.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось подтвердить");
    } finally {
      setBusy(false);
    }
  }

  const hashesMatch = Boolean(
    job &&
      job.state === "done" &&
      job.comparable &&
      job.kind !== "handbrake" &&
      job.kind !== "optical" &&
      job.kind !== "torrent" &&
      job.mismatchPaths.length === 0 &&
      job.files.length > 0 &&
      job.files.every((file) => file.status === "match"),
  );
  const canDelete = Boolean(hashesMatch && confirmed);

  return (
    <AppShell current="progress" subtitle="SHA-256">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Целостность</p>
          <h1 className="text-2xl font-semibold tracking-tight">{job?.title ?? "Хэш"}</h1>
        </div>
        <Link href="/progress" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          К очереди
        </Link>
      </header>
      {missing ? <p className="text-sm text-muted-foreground">Это не задача SHA-256. Хэши по ней не хранятся.</p> : null}
      {error && !job ? <p className="text-sm text-destructive">{error}</p> : null}
      {job ? (
        <>
          <section className="grid gap-2 rounded-xl border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>{stateLabel(job)}</span>
              <span className="tabular-nums">{Math.round(job.percent)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, job.percent))}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">
              {job.currentFile || "файл ещё не выбран"} · {job.filesDone}/{job.filesTotal} · {formatBytes(job.bytesHashed)} из{" "}
              {formatBytes(job.bytesTotal)}
              {job.speed > 0 ? ` · ${formatSpeed(job.speed)}` : ""}
              {job.etaSeconds != null && job.state === "running" ? ` · осталось ${formatEta(job.etaSeconds)}` : ""}
            </p>
            {job.kind === "handbrake" ? (
              <p className="text-sm text-muted-foreground">Перекодирование меняет байты. Хэш входа и хэш выхода не сравниваются.</p>
            ) : null}
            {job.kind === "compact" ? (
              <p className="text-sm text-muted-foreground">
                Считаются логические байты файла, не размер кластера на диске. Сжатие NTFS не должно их менять.
              </p>
            ) : null}
            {job.mismatchPaths.length > 0 ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Отличается: {job.mismatchPaths.join(", ")}. Удаление исходных файлов выключено.
              </p>
            ) : null}
            {job.error ? <p className="text-sm text-destructive">{job.error}</p> : null}
            {job.discVerified ? (
              <p className="text-sm text-muted-foreground">Контрольные суммы записаны в каталог проверенного диска. Носитель не стирался.</p>
            ) : null}
          </section>
          <FileTable job={job} />
          <section className="grid gap-3 rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">{job.deleteReason}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
              Подтверждаю удаление исходных файлов
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy || job.state === "done" || job.state === "cancelled"} onClick={() => void cancel()}>
                Отменить подсчёт
              </Button>
              <Button type="button" variant="destructive" disabled={busy || !canDelete} onClick={() => void confirmDelete()}>
                удалить исходные файлы
              </Button>
            </div>
            {!canDelete ? <p className="text-xs text-muted-foreground">Кнопка выключена: {job.deleteReason}</p> : null}
          </section>
        </>
      ) : null}
    </div>
    </AppShell>
  );
}

function FileTable({ job }: { job: IntegrityJob }) {
  if (job.kind === "handbrake") {
    return (
      <div className="grid gap-4">
        <HashList title="хэш входа" files={job.files.filter((file) => file.side === "source")} />
        <HashList title="хэш выхода" files={job.files.filter((file) => file.side === "destination")} />
      </div>
    );
  }
  return <HashList title="Файлы" files={job.files} />;
}

function HashList({ title, files }: { title: string; files: HashFileRecord[] }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {files.length === 0 ? <p className="text-sm text-muted-foreground">Список ещё пуст.</p> : null}
      <ul className="grid gap-2">
        {files.map((file) => (
          <li key={`${file.side}:${file.relativePath}`} className="rounded-lg border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs break-all">{file.relativePath}</span>
              <span>{HASH_STATUS_LABEL[file.status]}</span>
            </div>
            <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
              {file.sha256 || "—"} · {formatBytes(file.bytesHashed)} / {formatBytes(file.size)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function stateLabel(job: IntegrityJob): string {
  if (job.state === "cancelled") return "Отменено";
  if (job.state === "paused") return "На паузе";
  if (job.state === "running") return "Считается";
  if (job.state === "queued") return "В очереди";
  if (job.state === "error") return "Ошибка";
  if (job.mismatchPaths.length > 0) return "Есть отличия";
  return "Готово";
}
