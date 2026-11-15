"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";

interface LaunchButton {
  program: string;
  kind: "native" | "emulator" | "port";
  kindLabel: string;
  machineLabel: string;
  ready: boolean;
  reason: string;
  firmwareNote: string;
}

interface ShelfCard {
  id: string;
  name: string;
  platform: string;
  platformLabel: string;
  initials: string;
  coverDataUrl: string | null;
  coverFile: string | null;
  year: number | null;
  developer: string | null;
  summary: string;
  active: "hdd" | "ssd";
  placement: string;
  hddPath: string;
  ssdPath: string;
  transfer: "idle" | "to-ssd" | "on-ssd" | "to-hdd";
  sourceKept: true;
  compact: string;
  compactArgv: string[] | null;
  compactReason: string;
  firmwarePath: string | null;
  keysPath: string | null;
  sample: boolean;
  launch: LaunchButton;
}

interface ShelfResponse {
  showingSamples: boolean;
  pool: string;
  tools: {
    ppsspp: string | null;
    pcsx2: string | null;
    shadps4: string | null;
    ryujinx: string | null;
    openGothic: string | null;
  };
  platforms: { id: string; label: string; games: ShelfCard[] }[];
}

const TILE: Record<string, string> = {
  windows: "from-zinc-700 to-zinc-900",
  macos: "from-sky-800 to-slate-900",
  switch: "from-red-800 to-zinc-900",
  psp: "from-indigo-800 to-zinc-900",
  ps2: "from-violet-800 to-zinc-900",
  ps4: "from-blue-800 to-zinc-900",
};

export function GameLibraryPanel() {
  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [platform, setPlatform] = useState("windows");
  const [tools, setTools] = useState<ShelfResponse["tools"] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((next: ShelfResponse) => {
    setShelf(next);
    setTools(next.tools);
  }, []);

  const load = useCallback(async () => {
    apply(await api<ShelfResponse>("/api/games"));
  }, [apply]);

  useEffect(() => {
    const kick = window.setTimeout(() => {
      void load().catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Библиотека не открылась"));
    }, 0);
    return () => window.clearTimeout(kick);
  }, [load]);

  async function act(id: string, action: "want" | "return" | "launch") {
    setBusy(`${action}:${id}`);
    try {
      const result = await api<{ shelf: ShelfResponse; error?: string | null; launched?: boolean; copied?: boolean }>(
        "/api/games",
        { method: "POST", body: JSON.stringify({ action, id }) },
      );
      if (result.shelf) apply(result.shelf);
      if (action === "launch" && result.launched === false) toast.message(result.error || "Запуск не начат");
      if (action === "want") toast.success(result.copied ? "Копия на SSD проверена. Оригинал на месте." : "Перенос на SSD поставлен. Оригинал не удаляется.");
      if (action === "return") toast.success("Игра снова на HDD. Оригинал не удалялся.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Действие не выполнено");
    } finally {
      setBusy(null);
    }
  }

  async function saveTools() {
    if (!tools) return;
    setBusy("tools");
    try {
      apply(await api<ShelfResponse>("/api/games", { method: "POST", body: JSON.stringify({ action: "tools", tools }) }));
      toast.success("Пути программ сохранены. Ничего не скачивалось.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Пути не сохранены");
    } finally {
      setBusy(null);
    }
  }

  async function saveFirmware(game: ShelfCard, firmwarePath: string, keysPath: string) {
    setBusy(`firmware:${game.id}`);
    try {
      apply(
        await api<ShelfResponse>("/api/games", {
          method: "POST",
          body: JSON.stringify({ action: "firmware", id: game.id, firmwarePath, keysPath }),
        }),
      );
      toast.success("Путь сохранён. Файл не скачивался.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Путь не сохранён");
    } finally {
      setBusy(null);
    }
  }

  const current = shelf?.platforms.find((item) => item.id === platform) ?? shelf?.platforms[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Библиотека игр</h1>
        <p className="text-sm text-muted-foreground">
          {shelf?.showingSamples
            ? "Образец полок. Файлы с диска не читаются, прошивки и ключи не скачиваются."
            : "Свои игры. Оригинал остаётся, пока копия не проверена и вы сами не заберёте её из пула."}
        </p>
      </div>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Платформы">
        {(shelf?.platforms ?? []).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === current?.id}
            className={`rounded-full px-3 py-1 text-xs ${item.id === current?.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
            onClick={() => setPlatform(item.id)}
          >
            {item.label}
            <span className="ml-1 tabular-nums">{item.games.length}</span>
          </button>
        ))}
      </div>

      {current && current.games.length === 0 ? <p className="text-sm text-muted-foreground">На этой платформе игр нет.</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {current?.games.map((game) => (
          <article key={game.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
            <div className={`relative grid aspect-[2/3] max-h-64 place-items-center bg-gradient-to-b ${TILE[game.platform] ?? TILE.windows}`}>
              {game.coverDataUrl ? (
                <div className="h-full w-full bg-cover bg-center" style={{ backgroundImage: `url("${game.coverDataUrl}")` }} role="img" aria-label={`Обложка ${game.name}`} />
              ) : (
                <span className="text-4xl font-semibold tracking-tight text-white">{game.initials}</span>
              )}
              <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">{game.platformLabel}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-3">
              <div>
                <h2 className="font-semibold leading-tight">{game.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {[game.developer, game.year].filter(Boolean).join(" · ") || "Без метаданных"}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">{game.summary}</p>
              <p className="text-xs" id={`${game.id}-launch`}>
                {game.launch.machineLabel} · {game.launch.kindLabel} · {game.launch.program}
              </p>
              <p className="text-xs text-muted-foreground">{game.placement}. Оригинал не удаляется.</p>
              {game.compactReason ? <p className="break-all text-[11px] text-muted-foreground">{game.compactReason}</p> : null}
              {game.compactArgv ? <p className="break-all font-mono text-[11px] text-muted-foreground">{game.compactArgv.join(" ")}</p> : null}
              <p className="text-[11px] text-muted-foreground">{game.launch.firmwareNote}</p>
              {game.launch.kind === "emulator" ? (
                <FirmwareFields game={game} disabled={busy !== null} onSave={saveFirmware} />
              ) : null}
              <div className="mt-auto flex flex-col gap-2 pt-1">
                <Button
                  type="button"
                  disabled={!game.launch.ready || busy !== null}
                  aria-describedby={`${game.id}-launch`}
                  onClick={() => void act(game.id, "launch")}
                >
                  Запустить
                </Button>
                <p className="text-[11px] text-muted-foreground">{game.launch.reason}</p>
                {game.transfer === "on-ssd" || game.transfer === "to-ssd" ? (
                  <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void act(game.id, "return")}>
                    Вернуть на HDD
                  </Button>
                ) : (
                  <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void act(game.id, "want")}>
                    Хочу играть
                  </Button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>

      <section className="rounded-xl border p-3">
        <h2 className="text-sm font-semibold">Программы на диске</h2>
        <p className="mb-3 text-xs text-muted-foreground">Полный путь к уже установленной программе. Склад её не скачивает.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToolField label="PPSSPP" value={tools?.ppsspp ?? ""} onChange={(value) => setTools((current) => ({ ...(current ?? emptyTools()), ppsspp: value }))} />
          <ToolField label="PCSX2" value={tools?.pcsx2 ?? ""} onChange={(value) => setTools((current) => ({ ...(current ?? emptyTools()), pcsx2: value }))} />
          <ToolField label="shadPS4" value={tools?.shadps4 ?? ""} onChange={(value) => setTools((current) => ({ ...(current ?? emptyTools()), shadps4: value }))} />
          <ToolField label="Ryujinx или аналог" value={tools?.ryujinx ?? ""} onChange={(value) => setTools((current) => ({ ...(current ?? emptyTools()), ryujinx: value }))} />
          <ToolField label="OpenGothic" value={tools?.openGothic ?? ""} onChange={(value) => setTools((current) => ({ ...(current ?? emptyTools()), openGothic: value }))} />
        </div>
        <Button type="button" className="mt-3" variant="secondary" disabled={busy !== null} onClick={() => void saveTools()}>
          Сохранить пути
        </Button>
      </section>
    </div>
  );
}

function emptyTools(): ShelfResponse["tools"] {
  return { ppsspp: "", pcsx2: "", shadps4: "", ryujinx: "", openGothic: "" };
}

function ToolField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <Input value={value} placeholder="C:\Games\Emu\program.exe" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function FirmwareFields({
  game,
  disabled,
  onSave,
}: {
  game: ShelfCard;
  disabled: boolean;
  onSave: (game: ShelfCard, firmwarePath: string, keysPath: string) => Promise<void>;
}) {
  const [firmware, setFirmware] = useState(game.firmwarePath ?? "");
  const [keys, setKeys] = useState(game.keysPath ?? "");
  return (
    <div className="flex flex-col gap-1">
      <Input value={firmware} placeholder="Путь к своей прошивке" aria-label={`Прошивка ${game.name}`} onChange={(event) => setFirmware(event.target.value)} />
      <Input value={keys} placeholder="Путь к своим ключам" aria-label={`Ключи ${game.name}`} onChange={(event) => setKeys(event.target.value)} />
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void onSave(game, firmware, keys)}>
        Сохранить пути к файлам
      </Button>
    </div>
  );
}
