"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { INDEX_LABEL, KIND_LABEL, POST_LABEL, REASON_LABEL, SUBTYPE_LABEL, kindLabel } from "@/lib/content/labels";
import { CONTENT_KINDS, GAME_SUBTYPES, type ContentKind, type GameSubtype } from "@/lib/content/types";
import type { TorrentPlacement } from "@/lib/policies/types";

const controlClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function TorrentPlacementCard({
  hostId,
  hash,
  onChanged,
}: {
  hostId: string;
  hash: string;
  onChanged: () => void;
}) {
  const [placement, setPlacement] = useState<TorrentPlacement | null>(null);
  const [kind, setKind] = useState<ContentKind>("other");
  const [subtype, setSubtype] = useState<GameSubtype>("other");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<TorrentPlacement>(`/api/torrents/${hostId}/${hash}/placement`)
      .then((next) => {
        if (cancelled) return;
        setPlacement(next);
        setKind(next.kind);
        setSubtype(next.gameSubtype ?? "other");
      })
      .catch(() => {
        if (!cancelled) setPlacement(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, hash]);

  async function save(nextKind: ContentKind, nextSubtype: GameSubtype) {
    setBusy(true);
    try {
      await api("/api/overrides", {
        method: "POST",
        body: JSON.stringify({
          hostId,
          hash,
          kind: nextKind,
          gameSubtype: nextKind === "game" ? nextSubtype : null,
        }),
      });
      const next = await api<TorrentPlacement>(`/api/torrents/${hostId}/${hash}/placement`);
      setPlacement(next);
      setKind(next.kind);
      setSubtype(next.gameSubtype ?? "other");
      toast.success("Тип запомнен. Он важнее расширения и имени");
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить тип");
    } finally {
      setBusy(false);
    }
  }

  if (!placement) return null;
  const queue =
    placement.scheduler === "active"
      ? "сейчас может качать — на диске один активный слот"
      : placement.scheduler === "queued"
        ? "ждёт слот: на этом диске уже есть активная загрузка"
        : placement.scheduler === "waiting-offline"
          ? "диск не в сети, загрузка не стартует"
          : null;

  return (
    <section className="grid gap-3 rounded-xl border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Тип и куда ляжет</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {kindLabel(placement.kind, placement.gameSubtype)} · {REASON_LABEL[placement.reason]}
          </p>
        </div>
        <Link href="/policies" className="shrink-0 text-xs text-primary hover:underline">
          Правила раскладки
        </Link>
      </div>
      <p className="text-sm">{placement.detail}</p>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Диск и папка</dt>
          <dd>
            {placement.diskLabel}
            {placement.folder ? ` / ${placement.folder}` : ""}
            <span className={placement.diskOnline ? " text-muted-foreground" : " text-warn"}>
              {placement.diskOnline ? " · в сети" : " · нет в сети"}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Путь</dt>
          <dd className="font-mono text-xs break-all">{placement.destinationPath || "—"}</dd>
        </div>
        <div className="text-xs text-muted-foreground">
          {INDEX_LABEL[placement.indexProfile]}
          {placement.indexNote ? `. ${placement.indexNote}` : ""}
          {" · "}
          {placement.postUnavailable
            ? `Сжатие NTFS недоступно. ${placement.postNote ?? ""}`
            : POST_LABEL[placement.postAction]}
        </div>
      </dl>
      {queue ? <p className="text-xs text-muted-foreground">{queue}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Тип
          <select
            aria-label="Тип раздачи"
            className={controlClass}
            value={kind}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as ContentKind;
              setKind(next);
              void save(next, subtype);
            }}
          >
            {CONTENT_KINDS.map((item) => (
              <option key={item} value={item}>
                {KIND_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Подтип игры
          <select
            aria-label="Подтип игры"
            className={controlClass}
            value={subtype}
            disabled={busy || kind !== "game"}
            onChange={(event) => {
              const next = event.target.value as GameSubtype;
              setSubtype(next);
              void save(kind, next);
            }}
          >
            {GAME_SUBTYPES.map((item) => (
              <option key={item} value={item}>
                {SUBTYPE_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
