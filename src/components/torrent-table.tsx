"use client";

import Link from "next/link";

import { ProgressBar, ProgressLabel } from "@/components/progress-bar";
import { StateBadge } from "@/components/state-badge";
import { formatBytes, formatSpeed } from "@/lib/format";
import { torrentJobId } from "@/lib/progress/ids";
import { cn } from "@/lib/utils";
import type { TorrentView } from "@/lib/qbittorrent/types";

export function TorrentTable({
  torrents,
  selectedKey,
  onSelect,
}: {
  torrents: TorrentView[];
  selectedKey: string | null;
  onSelect: (torrent: TorrentView) => void;
}) {
  return (
    <>
      <div className="hidden min-w-[860px] md:block">
        <div className="grid grid-cols-[minmax(220px,1.5fr)_130px_150px_170px_92px_minmax(180px,1.1fr)] gap-3 border-b px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>Раздача</span>
          <span>Хост</span>
          <span>Состояние</span>
          <span>Прогресс</span>
          <span>Размер</span>
          <span>Каталог</span>
        </div>
        {torrents.map((torrent) => {
          const key = `${torrent.hostId}:${torrent.hash}`;
          const selected = key === selectedKey;
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => onSelect(torrent)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(torrent);
                }
              }}
              className={cn(
                "grid cursor-pointer grid-cols-[minmax(220px,1.5fr)_130px_150px_170px_92px_minmax(180px,1.1fr)] gap-3 border-b px-4 py-3 text-sm outline-none hover:bg-muted/40 focus-visible:bg-muted/50",
                selected && "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]",
              )}
            >
              <NameCell torrent={torrent} />
              <span className="truncate text-muted-foreground">{torrent.hostName}</span>
              <span>
                <StateBadge state={torrent.state} rawState={torrent.rawState} />
              </span>
              <ProgressCell torrent={torrent} />
              <span className="tabular-nums text-muted-foreground">{formatBytes(torrent.size)}</span>
              <span className="truncate font-mono text-xs text-muted-foreground" title={torrent.savePath}>
                {torrent.savePath}
              </span>
            </div>
          );
        })}
      </div>
      <div className="md:hidden">
        {torrents.map((torrent) => {
          const key = `${torrent.hostId}:${torrent.hash}`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(torrent)}
              className={cn(
                "block w-full border-b px-4 py-3 text-left",
                key === selectedKey && "bg-primary/10",
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <NameCell torrent={torrent} />
                <StateBadge state={torrent.state} rawState={torrent.rawState} />
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                {torrent.hostName} · {formatBytes(torrent.size)}
              </span>
              <ProgressCell torrent={torrent} />
              <span className="mt-2 block truncate font-mono text-[11px] text-muted-foreground">{torrent.savePath}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function NameCell({ torrent }: { torrent: TorrentView }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium">{torrent.name}</span>
      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        {torrent.category ? <span>{torrent.category}</span> : null}
        {torrent.moveMark ? <span className="text-warn">к переносу</span> : null}
        <Link
          href={`/progress/${encodeURIComponent(torrentJobId(torrent.hostId, torrent.hash))}`}
          onClick={(event) => event.stopPropagation()}
          className="text-primary hover:underline"
        >
          прогресс
        </Link>
      </span>
    </span>
  );
}

function ProgressCell({ torrent }: { torrent: TorrentView }) {
  return (
    <span className="mt-2 block md:mt-0">
      <span className="mb-1 flex items-center justify-between text-xs tabular-nums">
        <ProgressLabel value={torrent.progress} />
        <span className="text-muted-foreground">
          {torrent.dlspeed > 0 ? `↓ ${formatSpeed(torrent.dlspeed)}` : null}
          {torrent.dlspeed > 0 && torrent.upspeed > 0 ? " " : null}
          {torrent.upspeed > 0 ? `↑ ${formatSpeed(torrent.upspeed)}` : null}
        </span>
      </span>
      <ProgressBar value={torrent.progress} state={torrent.state} />
    </span>
  );
}
