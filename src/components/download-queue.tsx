"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatPercent } from "@/lib/format";
import { stateLabel } from "@/lib/labels";
import { torrentJobId } from "@/lib/progress/ids";
import { NEXT_PRIORITY, type DiskQueueView, type QueueTorrentRef } from "@/lib/scheduler/types";

export type QueueCommand =
  | { action: "up" | "down" | "next"; diskKey: string; torrentKey: string }
  | { action: "pause" | "resume"; hostId: string; hash: string };

export function DownloadQueue({
  queues,
  pending,
  onCommand,
}: {
  queues: DiskQueueView[];
  pending: boolean;
  onCommand: (command: QueueCommand) => void;
}) {
  return (
    <section className="grid gap-3" aria-label="Очередь загрузок">
      <div>
        <h2 className="text-base font-semibold">Очередь загрузок</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          На каждом физическом диске одновременно качается только одна раздача. Раздача уже скачанного не ограничена.
        </p>
      </div>
      {queues.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-8">
          <p className="font-medium">Нет загрузок в очереди</p>
          <p className="mt-1 text-sm text-muted-foreground">Когда появятся раздачи, здесь будет слот каждого диска.</p>
        </div>
      ) : (
        queues.map((queue) => <DiskCard key={queue.diskKey} queue={queue} pending={pending} onCommand={onCommand} />)
      )}
    </section>
  );
}

function DiskCard({
  queue,
  pending,
  onCommand,
}: {
  queue: DiskQueueView;
  pending: boolean;
  onCommand: (command: QueueCommand) => void;
}) {
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{queue.label}</h3>
        <span className="text-xs text-muted-foreground">{queue.online ? "подключён" : "не подключён"}</span>
      </div>
      {queue.offlineReason ? <p className="mt-2 text-sm text-warn">{queue.offlineReason}</p> : null}
      {queue.fallbackNote ? <p className="mt-2 text-xs text-muted-foreground">{queue.fallbackNote}</p> : null}
      <div className="mt-3">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Сейчас качается</p>
        {queue.active ? (
          <>
            <QueueRow item={queue.active} />
            <div className="mt-2">
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  const active = queue.active;
                  if (!active) return;
                  onCommand({ action: "pause", hostId: active.hostId, hash: active.hash });
                }}
              >
                Пауза
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{queue.online ? "Слот свободен" : "Ждёт диск"}</p>
        )}
      </div>
      <div className="mt-4">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Ждут</p>
        {queue.waiting.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Очередь пуста</p>
        ) : (
          <ol className="mt-2 grid gap-2">
            {queue.waiting.map((item, index) => (
              <li key={item.key} className="rounded-lg border px-3 py-2">
                <QueueRow item={item} index={index + 1} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending || index === 0}
                    onClick={() => onCommand({ action: "up", diskKey: queue.diskKey, torrentKey: item.key })}
                  >
                    Выше
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending || index === queue.waiting.length - 1}
                    onClick={() => onCommand({ action: "down", diskKey: queue.diskKey, torrentKey: item.key })}
                  >
                    Ниже
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending || item.priority >= NEXT_PRIORITY}
                    onClick={() => onCommand({ action: "next", diskKey: queue.diskKey, torrentKey: item.key })}
                  >
                    Следующим
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {queue.manual.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">На паузе вручную</p>
          <ul className="mt-2 grid gap-2">
            {queue.manual.map((item) => (
              <li key={item.key} className="rounded-lg border px-3 py-2">
                <QueueRow item={item} />
                <div className="mt-2">
                  <Button
                    size="xs"
                    disabled={pending}
                    onClick={() => onCommand({ action: "resume", hostId: item.hostId, hash: item.hash })}
                  >
                    Продолжить
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {queue.seeding.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Раздача не ограничена:{" "}
          {queue.seeding.map((item) => `${item.name} (${stateLabel(item.state, item.rawState)})`).join(", ")}
        </p>
      ) : null}
    </article>
  );
}

function QueueRow({ item, index }: { item: QueueTorrentRef; index?: number }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/progress/${encodeURIComponent(torrentJobId(item.hostId, item.hash))}`}
          className="truncate font-medium hover:text-primary"
        >
          {index ? `${index}. ` : ""}
          {item.name}
        </Link>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatPercent(item.progress)}
          {item.priority >= NEXT_PRIORITY ? " · следующим" : ""}
        </span>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {item.hostName} · {stateLabel(item.state, item.rawState)}
      </p>
      <p className="truncate font-mono text-[11px] text-muted-foreground" title={item.savePath}>
        {item.savePath}
      </p>
    </div>
  );
}
