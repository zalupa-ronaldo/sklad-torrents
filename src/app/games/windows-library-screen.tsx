"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api-client";
import { compressRequest, moveRequest, settingsRequest } from "@/lib/windows-library/screen-actions";
import type { LibraryView, PublicWindowsGame } from "@/lib/windows-library/types";

const DEMO: PublicWindowsGame[] = [
  {
    id: "demo-hades",
    title: "Hades",
    launcher: "steam",
    steamAppId: 1145360,
    root: "D:\\Games\\Hades",
    serial: "DEMO",
    uuid: "demo",
    logicalBytes: 11_100_000_000,
    allocatedBytes: 8_400_000_000,
    compression: "compressed",
    algorithm: "XPRESS8K",
    cover: { cacheKey: "steam:1145360", source: "steam-app", url: null, cached: false },
    pool: "archive",
    online: true,
    job: null,
  },
];

export function WindowsLibraryScreen({ demo }: { demo: boolean }) {
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: "play" | "return" } | null>(null);
  const [notRunning, setNotRunning] = useState(false);
  const [ssd, setSsd] = useState({ serial: "", uuid: "", root: "" });

  async function reload() {
    const next = await api<LibraryView>("/api/windows-library");
    setLibrary(next);
    if (next.settings.fastSsd) setSsd(next.settings.fastSsd);
  }

  useEffect(() => {
    let gone = false;
    reload().catch((reason: unknown) => {
      if (!gone) setError(reason instanceof Error ? reason.message : "Библиотека не прочиталась.");
    });
    return () => {
      gone = true;
    };
  }, []);

  const live = library?.games ?? [];
  const cards = demo ? [...live, ...DEMO] : live;
  const archive = cards.filter((game) => game.pool === "archive");
  const playing = cards.filter((game) => game.pool === "playing");
  const current = cards.find((game) => game.id === selected) ?? null;

  async function submitMove() {
    if (!pending) return;
    const request = moveRequest({ ...pending, confirmed: true, notRunning });
    if (!request.ok) {
      setError(request.reason);
      return;
    }
    if (pending.id.startsWith("demo-")) {
      setError("Демо-карточка не записывается в рабочую библиотеку.");
      setPending(null);
      return;
    }
    try {
      await api("/api/windows-library", { method: "POST", body: JSON.stringify(request.body) });
      setPending(null);
      setNotRunning(false);
      await reload();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Задание не поставлено.");
    }
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">Один снимок библиотеки. Диск по таймеру не опрашивается.</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void api("/api/windows-library", { method: "POST", body: JSON.stringify(settingsRequest(ssd)) })
            .then(() => reload())
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "SSD не сохранён."));
        }}
      >
        <label className="grid text-xs">Серийный номер<input className="rounded border px-2 py-1" value={ssd.serial} onChange={(event) => setSsd({ ...ssd, serial: event.target.value })} /></label>
        <label className="grid text-xs">UUID<input className="rounded border px-2 py-1" value={ssd.uuid} onChange={(event) => setSsd({ ...ssd, uuid: event.target.value })} /></label>
        <label className="grid text-xs">Корень SSD<input className="rounded border px-2 py-1" value={ssd.root} onChange={(event) => setSsd({ ...ssd, root: event.target.value })} /></label>
        <Button type="submit" variant="secondary">Сохранить SSD</Button>
      </form>
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <section>
          <h2 className="mb-2 text-sm font-medium">Библиотека</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {archive.map((game) => (
              <article
                key={game.id}
                draggable={!game.id.startsWith("demo-")}
                onDragStart={(event) => event.dataTransfer.setData("text/game-id", game.id)}
                onClick={() => setSelected(game.id)}
                className="cursor-grab rounded-lg border p-2"
              >
                <Cover game={game} />
                <b className="mt-2 block text-sm">{game.title}</b>
                <small className="text-muted-foreground">{game.launcher} · {sizeLabel(game.logicalBytes)}</small>
              </article>
            ))}
            {archive.length === 0 ? <p className="text-sm text-muted-foreground">В архиве пока нет игр.</p> : null}
          </div>
        </section>
        <section
          className="rounded-lg border border-dashed p-3"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData("text/game-id");
            if (id) setPending({ id, kind: "play" });
          }}
        >
          <h2 className="mb-2 text-sm font-medium">Играю сейчас</h2>
          {playing.map((game) => (
            <article key={game.id} className="mb-2 rounded border p-2" onClick={() => setSelected(game.id)}>
              <b className="text-sm">{game.title}</b>
              <div>
                <Button type="button" variant="secondary" onClick={() => setPending({ id: game.id, kind: "return" })}>Вернуть в архив</Button>
              </div>
            </article>
          ))}
          {playing.length === 0 ? <p className="text-sm text-muted-foreground">Перетащите игру сюда. Копия проверяется, источник снимается только после подтверждения.</p> : null}
        </section>
      </div>
      {current ? <Details game={current} onCompress={() => void compress(current.id, reload, setError)} /> : null}
      {pending ? (
        <dialog open className="fixed inset-auto bottom-6 left-1/2 z-10 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border bg-background p-4 shadow-lg">
          <p className="text-sm">Удалить источник после проверки копии? Чужие файлы не перезаписываются.</p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={notRunning} onChange={(event) => setNotRunning(event.target.checked)} />
            Игра не запущена
          </label>
          <div className="mt-3 flex gap-2">
            <Button type="button" onClick={() => void submitMove()}>Поставить в очередь</Button>
            <Button type="button" variant="secondary" onClick={() => { setPending(null); setNotRunning(false); }}>Отмена</Button>
          </div>
        </dialog>
      ) : null}
      {demo ? <p className="text-xs text-muted-foreground">Демо включено параметром demo=1 и в библиотеку не пишется.</p> : null}
    </div>
  );
}

function Cover({ game }: { game: PublicWindowsGame }) {
  if (game.cover.url && game.cover.cached) return <img alt={game.title} src={game.cover.url} className="aspect-[2/3] w-full rounded object-cover" />;
  return <div className="grid aspect-[2/3] place-items-center rounded bg-muted text-lg">{game.title.slice(0, 2)}</div>;
}

function Details({ game, onCompress }: { game: PublicWindowsGame; onCompress: () => void }) {
  return (
    <aside className="rounded-lg border p-3 text-sm">
      <h2 className="font-medium">{game.title}</h2>
      <p>Диск {game.serial} · {game.uuid}</p>
      <p>Логический размер {sizeLabel(game.logicalBytes)}, на диске {sizeLabel(game.allocatedBytes)}</p>
      <p>Сжатие: {game.compression}{game.algorithm ? ` · ${game.algorithm}` : ""}</p>
      <p className="break-all">{game.root}</p>
      {game.job ? <p>Задание {game.job.kind}: {game.job.state}, {game.job.percent}%</p> : null}
      <Button type="button" variant="secondary" onClick={onCompress}>Сжать в очереди</Button>
    </aside>
  );
}

async function compress(id: string, reload: () => Promise<void>, setError: (value: string | null) => void) {
  if (id.startsWith("demo-")) {
    setError("Демо-карточка не сжимается.");
    return;
  }
  try {
    await api("/api/windows-library", { method: "POST", body: JSON.stringify(compressRequest(id)) });
    await reload();
  } catch (reason) {
    setError(reason instanceof ApiError ? reason.message : "Сжатие не поставлено.");
  }
}

function sizeLabel(bytes: number | null): string {
  if (bytes == null) return "неизвестно";
  if (bytes < 1024) return `${bytes} Б`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
}
