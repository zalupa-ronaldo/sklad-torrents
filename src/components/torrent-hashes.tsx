"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { HASH_STATUS_LABEL, type HashFileRecord } from "@/lib/integrity/types";

interface ManifestPayload {
  ready: boolean;
  filename: string;
  text: string;
  files: HashFileRecord[];
  enqueued?: boolean;
}

export function TorrentHashes({ hostId, hash, name, complete }: { hostId: string; hash: string; name: string; complete: boolean }) {
  const [payload, setPayload] = useState<ManifestPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await api<ManifestPayload>(`/api/torrents/${hostId}/${hash}/hashes`);
    setPayload(next);
  }, [hostId, hash]);

  useEffect(() => {
    if (!complete) return;
    const kick = window.setTimeout(() => {
      void load().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(kick);
  }, [complete, load]);

  useEffect(() => {
    if (!complete || payload?.ready) return;
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [complete, load, payload?.ready]);

  async function enqueue() {
    setBusy(true);
    try {
      const next = await api<ManifestPayload>(`/api/torrents/${hostId}/${hash}/hashes`, { method: "POST" });
      setPayload(next);
      if (next.ready) toast.success("Манифест собран из сохранённых хэшей");
      else toast.success("SHA-256 поставлен в очередь");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось поставить хэш в очередь");
    } finally {
      setBusy(false);
    }
  }

  async function copyManifest() {
    if (!payload?.ready) {
      await enqueue();
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.text);
      toast.success(`Скопирован ${payload.filename}`);
    } catch {
      download(payload.filename, payload.text);
      toast.success(`Сохранён ${payload.filename}`);
    }
  }

  if (!complete) return null;
  const files = (payload?.files ?? []).filter((file) => file.side === "source");

  return (
    <section className="grid gap-2 rounded-lg border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">SHA-256</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void enqueue()}>
            Посчитать SHA-256
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void copyManifest()}>
            Скопировать {payload?.filename || `${name}.sha256`}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Манифест собирается из уже посчитанных хэшей. Если их нет, кнопка только ставит фоновую задачу и не считает хэш в этом запросе.
      </p>
      {files.length === 0 ? <p className="text-xs text-muted-foreground">Хэши ещё не записаны.</p> : null}
      <ul className="grid gap-1">
        {files.map((file) => (
          <li key={file.relativePath} className="text-xs">
            <span className="text-muted-foreground">{HASH_STATUS_LABEL[file.status]}</span>{" "}
            <span className="font-mono break-all">{file.relativePath}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
