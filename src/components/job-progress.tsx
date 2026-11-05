"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/api-client";
import { DISC_IMAGE_STUDIO_RELEASES } from "@/lib/optical/disc-image-studio";

interface JobView {
  id: string;
  kind: string;
  state: "queued" | "running" | "done" | "error";
  progress: number;
  title: string;
  message: string;
  error: string | null;
  updatedAt: number;
}

const STATE_LABEL: Record<JobView["state"], string> = {
  queued: "в очереди",
  running: "выполняется",
  done: "готово",
  error: "ошибка",
};

export function JobProgress() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api<{ jobs: JobView[] }>("/api/jobs")
        .then((payload) => {
          if (!cancelled) {
            setJobs(payload.jobs);
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось прочитать очередь");
        });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Склад · очередь</p>
          <h1 className="text-2xl font-semibold tracking-tight">Прогресс</h1>
        </div>
        <nav className="flex gap-3 text-sm">
          <Link href="/" className="text-muted-foreground underline-offset-4 hover:underline">
            Раздачи
          </Link>
          <Link href="/optical" className="text-muted-foreground underline-offset-4 hover:underline">
            Оптика
          </Link>
        </nav>
      </header>
      <p className="text-sm text-muted-foreground">
        Общая очередь фоновых задач. Сборка рисунка и опрос IMAPI2 не блокируют окно. Готово здесь не значит, что
        болванка записана: в этом окружении диск не прожигался.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {jobs.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-8 text-sm text-muted-foreground">Очередь пустая.</p>
      ) : (
        <ul className="grid gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="grid gap-2 rounded-xl border bg-card p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium">{job.title}</h2>
                <span className="text-xs text-muted-foreground">{STATE_LABEL[job.state] ?? job.state}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
              </div>
              <p className="text-sm text-muted-foreground">{job.error || job.message}</p>
              {job.state === "error" && (job.error || "").includes("DiscImageStudio не найден") ? (
                <a className="text-sm underline underline-offset-4" href={DISC_IMAGE_STUDIO_RELEASES}>
                  Страница релизов DiscImageStudio
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
