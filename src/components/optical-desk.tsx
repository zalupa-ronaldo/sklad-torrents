"use client";

import { Disc } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { PROFILE_NAME, checkCapacity, treeBytes } from "@/lib/optical/capacity";
import type { BurnedDisc, DetectResult, IndexedPath, MediaProfile } from "@/lib/optical/media";
import { searchBurnedFiles } from "@/lib/optical/search";
import { cn } from "@/lib/utils";

interface Snapshot {
  demo: boolean;
  detection: DetectResult;
  files: IndexedPath[];
  fileSource: "drive-manager" | "demo";
  discs: BurnedDisc[];
}

const PROFILES: MediaProfile[] = ["cd", "dvd-sl", "dvd-dl"];

export function OpticalDesk() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [driveId, setDriveId] = useState<string>("");
  const [profile, setProfile] = useState<MediaProfile>("dvd-sl");
  const [picked, setPicked] = useState<string[]>([]);
  const [label, setLabel] = useState("Саундтрек");
  const [locationNote, setLocationNote] = useState("полка, коробка 2");
  const [outputDir, setOutputDir] = useState("/Volumes/vault/Cinema");
  const [eraseCheck, setEraseCheck] = useState(false);
  const [eraseTyped, setEraseTyped] = useState("");
  const [eraseBeforeBurn, setEraseBeforeBurn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await api<Snapshot>("/api/optical/dvd");
      setData(next);
      setError(null);
      setDriveId((current) => current || next.detection.drives[0]?.id || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось открыть приводы");
    }
  }, []);

  useEffect(() => {
    const kick = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const drive = data?.detection.drives.find((item) => item.id === driveId) ?? null;
  const files = useMemo(
    () => (data?.files ?? []).filter((file) => picked.includes(file.path)),
    [data?.files, picked],
  );
  const bytes = treeBytes(files);
  const capacity = files.length > 0 ? checkCapacity(bytes, profile) : null;
  const eraseUnlocked = eraseCheck || (label.trim().length > 0 && eraseTyped.trim() === label.trim());

  function toggle(path: string) {
    setPicked((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  }

  async function enqueue(action: "burn" | "iso" | "erase") {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await api("/api/optical/dvd/jobs", {
        method: "POST",
        body: JSON.stringify({
          action,
          profile,
          driveId: drive?.id,
          files: action === "erase" ? [] : files,
          outputDir,
          label,
          locationNote,
          eraseConfirmed: action === "erase" ? true : eraseBeforeBurn && eraseUnlocked,
        }),
      });
      setNotice(
        data?.demo
          ? "Задача в очереди. Это демо: процесс не запускался, диск не записан."
          : "Задача в очереди. Страница не ждёт окончания записи.",
      );
      setEraseBeforeBurn(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось поставить задачу");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDemo() {
    if (!data) return;
    await api("/api/optical/dvd", { method: "POST", body: JSON.stringify({ demo: !data.demo }) });
    await refresh();
  }

  const hits = searchBurnedFiles(data?.discs ?? [], query, data?.demo ? [] : data?.detection.drives ?? []);

  return (
    <section className="grid gap-4" data-testid="optical-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Disc className="size-4" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">Диски DVD</h2>
            <p className="text-sm text-muted-foreground">
              Рекордер подключён к Windows-ПК. Mac ставит задание в очередь и показывает имя привода, которое сообщил агент.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void toggleDemo()}>
            {data?.demo ? "Демо включено" : "Включить демо"}
          </Button>
          <Link href="/progress" className="inline-flex h-8 items-center rounded-lg border px-2.5 text-sm">
            Прогресс
          </Link>
        </div>
      </div>

      {data?.demo ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm" data-testid="demo-banner">
          Демо агента Windows. На Mac локальный DVD-привод не ищется. Команды только записываются в задачу, exit code имитируется.
          Физический диск не записывается.
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-primary">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-medium">Приводы</h3>
          {data && data.detection.drives.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="no-drive">
              Привод не найден. {data.detection.detail}
            </p>
          ) : (
            <ul className="mt-2 grid gap-2">
              {(data?.detection.drives ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`drive-${item.id}`}
                    onClick={() => {
                      setDriveId(item.id);
                      if (item.suggestedProfile) setProfile(item.suggestedProfile);
                    }}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-sm",
                      driveId === item.id ? "border-primary" : "border-border",
                    )}
                  >
                    <span className="font-medium">{item.name}</span>
                    {item.demo ? <span className="ml-2 text-xs text-warn">демо</span> : null}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {item.location === "internal" ? "внутренний" : item.location === "external" ? "внешний" : "расположение неизвестно"}
                      {" · "}
                      {item.device}
                      {" · "}
                      {item.media}
                      {item.rewritable ? " · перезаписываемый" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-medium">
            Файлы {data?.fileSource === "drive-manager" ? "из каталога дисков" : "демо-каталога"}
          </h3>
          <ul className="mt-2 grid max-h-64 gap-2 overflow-auto">
            {(data?.files ?? []).map((file) => (
              <li key={file.path} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={picked.includes(file.path)}
                  onCheckedChange={() => toggle(file.path)}
                  aria-label={file.name}
                  data-testid={`file-${file.name}`}
                />
                <span>
                  <span className="font-medium">{file.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {file.diskLabel} · {formatBytes(file.size)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PROFILES.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setProfile(item)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs",
              profile === item ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {PROFILE_NAME[item]}
          </button>
        ))}
      </div>
      {capacity && !capacity.ok ? (
        <p className="text-sm text-destructive" data-testid="capacity-warning">
          {capacity.reason}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="capacity-ok">
          Выбрано {formatBytes(bytes)}
          {capacity?.ok ? ` · влезает на ${PROFILE_NAME[profile]}` : ""}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Подпись диска" value={label} onChange={setLabel} testId="label-input" />
        <Field label="Где лежит болванка" value={locationNote} onChange={setLocationNote} testId="location-input" />
        <Field label="Папка для ISO" value={outputDir} onChange={setOutputDir} testId="output-input" />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button data-testid="iso-button" disabled={busy || !capacity?.ok} onClick={() => void enqueue("iso")}>
          Собрать образ
        </Button>
        <Button data-testid="burn-button" disabled={busy || !drive || !capacity?.ok} onClick={() => void enqueue("burn")}>
          Записать
        </Button>
      </div>

      {drive?.rewritable ? (
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-medium">Стирание {drive.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">Само не стирает. Кнопка молчит, пока не подтвердите.</p>
          <div className="mt-3 grid gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={eraseCheck} onCheckedChange={(value) => setEraseCheck(value === true)} data-testid="erase-confirm" />
              Подтверждаю стирание
            </label>
            <Input
              value={eraseTyped}
              onChange={(event) => setEraseTyped(event.target.value)}
              placeholder="Или введите подпись диска"
              aria-label="Подпись для стирания"
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={eraseBeforeBurn}
                disabled={!eraseUnlocked}
                onCheckedChange={(value) => setEraseBeforeBurn(value === true)}
              />
              Стереть перед записью
            </label>
            <Button
              variant="destructive"
              data-testid="erase-button"
              disabled={!eraseUnlocked || busy}
              onClick={() => void enqueue("erase")}
            >
              Стереть
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border p-3" data-testid="shelf">
        <h3 className="text-sm font-medium">Полка записанных дисков</h3>
        <Input
          className="mt-2"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Найти файл и сказать, какую болванку достать"
          aria-label="Поиск по полке"
          data-testid="shelf-search"
        />
        {query.trim() ? (
          <ul className="mt-3 grid gap-2">
            {hits.length === 0 ? <li className="text-sm text-muted-foreground">На полке такого файла нет.</li> : null}
            {hits.map((hit) => (
              <li key={`${hit.discId}:${hit.filePath}`} className="text-sm" data-testid="shelf-hit">
                {hit.message}
                <span className="mt-1 block text-xs text-muted-foreground">source: {hit.source}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="mt-3 grid gap-2">
            {(data?.discs ?? []).length === 0 ? (
              <li className="text-sm text-muted-foreground">Пока пусто. После успешной проверки демо-диск появится здесь как демо.</li>
            ) : null}
            {(data?.discs ?? []).map((disc) => (
              <li key={disc.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm" data-testid="shelf-disc">
                <span className="font-medium">{disc.label}</span>
                <span className="ml-2 text-xs text-warn">{disc.source === "mock" ? "демо, не настоящий DVD" : "запись утилитой"}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {disc.locationNote} · source: {disc.source} · {disc.files.map((file) => file.name).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId} />
    </label>
  );
}
