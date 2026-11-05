"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { osLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { HostView } from "@/lib/qbittorrent/types";

const fieldClass =
  "w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function AddTorrentDialog({
  open,
  hosts,
  defaultHostId,
  onClose,
  onAdded,
}: {
  open: boolean;
  hosts: HostView[];
  defaultHostId: string;
  onClose: () => void;
  onAdded: (hostId: string, hash: string | null) => void;
}) {
  const [hostId, setHostId] = useState(defaultHostId);
  const [mode, setMode] = useState<"magnet" | "file">("magnet");
  const [magnet, setMagnet] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [savePath, setSavePath] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  const host = hosts.find((item) => item.id === hostId) ?? hosts[0];
  const formToken = open ? `${defaultHostId}:${hosts.map((item) => item.id).join(",")}` : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (formToken !== openedFor) {
    setOpenedFor(formToken);
    if (formToken) {
      const nextHost = hosts.find((item) => item.id === defaultHostId) ?? hosts[0];
      setHostId(nextHost?.id ?? "");
      setMode("magnet");
      setMagnet("");
      setFile(null);
      setPaused(false);
      setSavePath(nextHost?.pathPresets[0]?.path ?? "");
    }
  }

  async function submit() {
    if (!host) return;
    setBusy(true);
    try {
      let result: { hashes: string[] };
      if (mode === "file") {
        if (!file) {
          toast.error("Выберите файл .torrent");
          return;
        }
        const form = new FormData();
        form.set("hostId", host.id);
        form.set("savePath", savePath);
        form.set("paused", paused ? "true" : "false");
        form.set("torrent", file);
        result = await api("/api/torrents", { method: "POST", body: form });
      } else {
        result = await api("/api/torrents", {
          method: "POST",
          body: JSON.stringify({ hostId: host.id, urls: magnet, savePath, paused }),
        });
      }
      toast.success(paused ? "Раздача добавлена на паузе" : "Раздача добавлена");
      onAdded(host.id, result.hashes[0] ?? null);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось добавить раздачу");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Добавить раздачу</DialogTitle>
          <DialogDescription>
            Файл ляжет в выбранный каталог на {host ? host.name : "хосте"}. qBittorrent сам качает и раздаёт.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="add-host">Хост</Label>
            <select
              id="add-host"
              className={cn(fieldClass, "h-8 py-0")}
              value={host?.id ?? ""}
              onChange={(event) => {
                const next = hosts.find((item) => item.id === event.target.value);
                setHostId(event.target.value);
                setSavePath(next?.pathPresets[0]?.path ?? "");
              }}
            >
              {hosts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {osLabel(item.os)}
                  {item.kind === "mock" ? " · демо" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant={mode === "magnet" ? "default" : "outline"} onClick={() => setMode("magnet")}>
              Магнет
            </Button>
            <Button type="button" variant={mode === "file" ? "default" : "outline"} onClick={() => setMode("file")}>
              Файл .torrent
            </Button>
          </div>
          {mode === "magnet" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="magnet">Ссылка</Label>
              <textarea
                id="magnet"
                value={magnet}
                onChange={(event) => setMagnet(event.target.value)}
                placeholder="magnet:?xt=urn:btih:…"
                className={cn(fieldClass, "min-h-24 font-mono text-xs")}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="torrent-file">Файл</Label>
              <Input
                id="torrent-file"
                type="file"
                accept=".torrent,application/x-bittorrent"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="save-path">Каталог на {host ? osLabel(host.os) : "машине"}</Label>
            {host && host.pathPresets.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {host.pathPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setSavePath(preset.path)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      savePath === preset.path ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground",
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            ) : null}
            <Input
              id="save-path"
              value={savePath}
              onChange={(event) => setSavePath(event.target.value)}
              placeholder={host?.os === "win32" ? "D:\\Downloads" : "/Volumes/vault/PSP/Games/Downloads"}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={paused} onCheckedChange={setPaused} />
            Добавить на паузе
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy || !savePath.trim()} onClick={() => void submit()}>
            {busy ? "Добавляем…" : "Добавить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
