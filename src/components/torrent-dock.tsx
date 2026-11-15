"use client";

import { useMemo, useState } from "react";

import { ProgressBar, ProgressLabel } from "@/components/progress-bar";
import { relocateBlocked, torrentMatches } from "@/components/panel-model";
import { StateBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { formatBytes, formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { HostView, TorrentView } from "@/lib/qbittorrent/types";

export function TorrentDock({
  torrents,
  hosts,
  query,
  onChanged,
}: {
  torrents: TorrentView[];
  hosts: HostView[];
  query: string;
  onChanged: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const visible = useMemo(() => torrents.filter((torrent) => torrentMatches(torrent, query)), [torrents, query]);
  const selected = visible.find((torrent) => `${torrent.hostId}:${torrent.hash}` === selectedKey) ?? null;
  const host = selected ? hosts.find((item) => item.id === selected.hostId) ?? null : null;
  const presets = (host?.pathPresets ?? []).filter((preset) => !relocateBlocked(preset.path));

  async function relocate() {
    if (!selected) return;
    const blocked = relocateBlocked(destination);
    if (blocked) {
      setNotice(blocked);
      return;
    }
    if (!destination.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/torrents/${selected.hostId}/${selected.hash}`, {
        method: "POST",
        body: JSON.stringify({ action: "location", location: destination.trim() }),
      });
      setNotice("Раздача продолжается. qBittorrent переносит файлы на этом же компьютере.");
      setDestination("");
      onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Перенос не выполнился");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="torrent-dock" className="flex min-h-0 min-w-0 flex-col border-t lg:border-t-0 lg:border-r">
      <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Раздачи</h2>
        <span className="text-[11px] text-muted-foreground">{query.trim() ? `${visible.length} в поиске` : `${visible.length}`}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">{query.trim() ? "В раздачах ничего не найдено." : "Раздач пока нет."}</p>
        ) : (
          visible.map((torrent) => {
            const key = `${torrent.hostId}:${torrent.hash}`;
            const active = key === selectedKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedKey(active ? null : key);
                  setDestination("");
                  setNotice(null);
                }}
                className={cn("block w-full border-t px-2 py-1.5 text-left hover:bg-muted/40", active && "bg-muted/50")}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-medium">{torrent.name}</span>
                  <StateBadge state={torrent.state} rawState={torrent.rawState} />
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {torrent.hostName} · {formatBytes(torrent.size)}
                  {torrent.dlspeed > 0 ? ` · ↓ ${formatSpeed(torrent.dlspeed)}` : ""}
                  {torrent.upspeed > 0 ? ` · ↑ ${formatSpeed(torrent.upspeed)}` : ""}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={torrent.savePath}>
                  Где лежит: {torrent.savePath}
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <ProgressBar value={torrent.progress} state={torrent.state} className="flex-1" />
                  <ProgressLabel value={torrent.progress} />
                </span>
              </button>
            );
          })
        )}
      </div>
      {selected && host ? (
        <form
          className="grid gap-1.5 border-t px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void relocate();
          }}
        >
          <p className="text-[11px] text-muted-foreground">
            Перенос на {host.name}. Раздача не снимается. Каталоги E: и Z: сюда не подставляются.
          </p>
          <div className="flex flex-wrap gap-1">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px]",
                  destination === preset.path ? "border-primary bg-primary/15" : "border-border text-muted-foreground",
                )}
                onClick={() => setDestination(preset.path)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <Input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={host.os === "win32" ? "D:\\Games" : "/Volumes/vault/Cinema"}
              aria-label="Каталог переноса раздачи"
              className="h-7 font-mono text-[11px]"
              spellCheck={false}
            />
            <Button type="submit" size="sm" className="h-7" disabled={busy || !destination.trim()}>
              {busy ? "Перенос…" : "Перенести"}
            </Button>
          </div>
          {notice ? <p className="text-[10px] text-muted-foreground">{notice}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
