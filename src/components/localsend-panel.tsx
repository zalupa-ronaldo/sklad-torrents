"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";

interface Device {
  alias: string;
  address: string;
  port: number;
  protocol: "http" | "https";
  fingerprint: string;
  demo: boolean;
  deviceModel: string | null;
}

interface Status {
  devices: Device[];
  lastError: string | null;
  mock: boolean;
  self: { alias: string; port?: number; protocol?: string; fingerprint: string } | null;
}

interface LocalFile {
  id: string;
  kind: "file" | "folder";
  name: string;
  path: string;
  size: number;
  filesystem: string;
  readable: boolean;
}

interface DriveHit {
  diskId: string;
  label: string;
  filesystem: string;
  path: string;
  name: string;
  kind: "file" | "dir";
  online: boolean;
  connectHint: string | null;
}

interface SettingsResponse {
  settings: {
    alias: string;
    receivePin: string;
    destination:
      | { mode: "disk"; diskId: string; folder: string }
      | { mode: "path"; os: "darwin" | "win32" | "linux"; path: string };
  };
  disks: { id: string; label: string; filesystem: string; mount: string; online: boolean }[];
}

export function LocalsendPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [hits, setHits] = useState<DriveHit[]>([]);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [pickedLocal, setPickedLocal] = useState<string[]>([]);
  const [pickedDrive, setPickedDrive] = useState<string[]>([]);
  const [ip, setIp] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const [nextStatus, nextFiles, nextSettings] = await Promise.all([
      api<Status>("/api/localsend/devices"),
      api<{ entries: LocalFile[] }>("/api/localsend/files"),
      api<SettingsResponse>("/api/localsend/settings"),
    ]);
    setStatus(nextStatus);
    setFiles(nextFiles.entries);
    setSettings(nextSettings);
    setFingerprint((current) => current || nextStatus.devices[0]?.fingerprint || "");
  }, []);

  useEffect(() => {
    const kick = window.setTimeout(() => {
      void load().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "LocalSend не ответил");
      });
    }, 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load().catch(() => undefined);
    }, 4000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [load]);

  async function searchDrive(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setHits([]);
      return;
    }
    const found = await api<{ hits: DriveHit[] }>(`/api/drives/search?q=${encodeURIComponent(value)}`);
    setHits(found.hits);
  }

  async function addIp() {
    try {
      const result = await api<{ device: Device }>("/api/localsend/devices", {
        method: "POST",
        body: JSON.stringify({ address: ip, port: 53317 }),
      });
      setFingerprint(result.device.fingerprint);
      setIp("");
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось добавить IP");
    }
  }

  async function send() {
    setSending(true);
    setNotice(null);
    const started = performance.now();
    try {
      const driveFiles = hits.filter((hit) => pickedDrive.includes(`${hit.diskId}:${hit.path}`));
      const result = await api<{ job: { id: string; state: string }; duplicate: boolean }>("/api/localsend/send", {
        method: "POST",
        body: JSON.stringify({
          fingerprint,
          entryIds: pickedLocal,
          driveFiles: driveFiles.map((hit) => ({
            diskId: hit.diskId,
            path: hit.path,
            name: hit.name,
            kind: hit.kind === "dir" ? "dir" : "file",
          })),
        }),
      });
      const waited = Math.round(performance.now() - started);
      setNotice(
        result.duplicate
          ? `Уже есть активная задача ${result.job.id}. Ответ за ${waited} мс, сокет не ждали.`
          : `Задача ${result.job.id} в состоянии «${result.job.state}». Ответ за ${waited} мс.`,
      );
      toast.success("Задача в очереди");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Отправка не поставлена в очередь");
    } finally {
      setSending(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    try {
      const saved = await api<{ settings: SettingsResponse["settings"] }>("/api/localsend/settings", {
        method: "PUT",
        body: JSON.stringify(settings.settings),
      });
      setSettings({ ...settings, settings: saved.settings });
      toast.success("Куда складывать входящие — сохранено");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Настройки не сохранились");
    }
  }

  const destination = settings?.settings.destination;

  return (
    <div className="grid gap-4">
      <section className="rounded-xl border p-4">
        <h2 className="text-base font-semibold">Устройства в сети</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Поиск — UDP multicast {`224.0.0.167:53317`}. Если мультикаст закрыт, добавьте IPv4 вручную. Отпечаток сертификата
          закрепляется: другое устройство с тем же адресом не подменит получателя молча. VLESS и прокси не используются.
        </p>
        {status?.mock ? (
          <p className="mt-3 rounded-lg bg-warn/15 px-3 py-2 text-sm text-warn">
            Демо-получатель включён переменной LOCALSEND_MOCK=1. Это не компьютер в сети. Если mock-сервер молчит, передача
            станет ошибкой, а не «отправлено».
          </p>
        ) : null}
        {status?.lastError ? <p className="mt-3 text-sm text-destructive">{status.lastError}</p> : null}
        {status?.self ? (
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            Этот Склад слушает {status.self.protocol} :{status.self.port}, отпечаток {status.self.fingerprint}
          </p>
        ) : null}
        <ul className="mt-4 grid gap-2">
          {(status?.devices ?? []).length === 0 ? <li className="text-sm text-muted-foreground">Пока никого не видно.</li> : null}
          {(status?.devices ?? []).map((device) => (
            <li key={device.fingerprint}>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2">
                <input
                  type="radio"
                  name="peer"
                  className="mt-1"
                  checked={fingerprint === device.fingerprint}
                  onChange={() => setFingerprint(device.fingerprint)}
                />
                <span>
                  <span className="font-medium">{device.alias}</span>
                  {device.demo ? <span className="ml-2 text-xs text-warn">Демо, не устройство в сети</span> : null}
                  <span className="mt-1 block font-mono text-xs text-muted-foreground">
                    {device.protocol}://{device.address}:{device.port}
                  </span>
                  <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{device.fingerprint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addIp();
          }}
        >
          <Input value={ip} onChange={(event) => setIp(event.target.value)} placeholder="192.168.1.20" aria-label="IP устройства" className="max-w-48" />
          <Button type="submit" variant="outline">
            Добавить по IP
          </Button>
        </form>
      </section>

      <section className="rounded-xl border p-4">
        <h2 className="text-base font-semibold">Что отправить</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Файлы, которые каталог уже знает. Папка уходит списком файлов внутри неё. Кнопка только ставит задачу в очередь.
        </p>
        <div className="mt-3">
          <Input
            value={query}
            onChange={(event) => void searchDrive(event.target.value)}
            placeholder="Поиск по полке дисков"
            aria-label="Поиск по полке"
          />
        </div>
        <ul className="mt-3 grid gap-1">
          {hits.map((hit) => {
            const key = `${hit.diskId}:${hit.path}`;
            return (
              <li key={key}>
                <label className="flex items-start gap-2 rounded-md px-1 py-1 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={pickedDrive.includes(key)}
                    onChange={() =>
                      setPickedDrive((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
                    }
                  />
                  <span>
                    <span className="font-medium">{hit.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {hit.label} · {hit.filesystem}
                      {hit.filesystem.toLowerCase() === "apfs" ? " · не NTFS" : ""}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">{hit.path}</span>
                    {hit.connectHint ? <span className="block text-xs text-warn">{hit.connectHint}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <h3 className="mt-4 text-sm font-medium">Файлы на этой машине</h3>
        <ul className="mt-2 grid gap-1">
          {files.map((file) => (
            <li key={file.id}>
              <label className="flex items-start gap-2 rounded-md px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={pickedLocal.includes(file.id)}
                  onChange={() =>
                    setPickedLocal((current) => (current.includes(file.id) ? current.filter((item) => item !== file.id) : [...current, file.id]))
                  }
                />
                <span>
                  <span className="font-medium">{file.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {file.kind === "folder" ? "папка" : formatBytes(file.size)} · {file.filesystem}
                    {file.readable ? "" : " · нет локальной копии"}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">{file.path}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" disabled={sending || !fingerprint || (pickedLocal.length === 0 && pickedDrive.length === 0)} onClick={() => void send()}>
            Поставить в очередь
          </Button>
          <Link href="/progress" className="text-sm text-primary underline-offset-4 hover:underline">
            Открыть прогресс
          </Link>
        </div>
        {notice ? <p className="mt-3 text-sm">{notice}</p> : null}
      </section>

      <section className="rounded-xl border p-4">
        <h2 className="text-base font-semibold">Куда складывать входящие</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Этот Склад сам принимает LocalSend и пишет в выбранный каталог. На Mac это путь APFS вроде /Volumes/vault/Incoming, на
          Windows — NTFS вроде D:\Incoming. Путь Mac не считается NTFS. После реального upload файл добавляется в индекс полки и
          проходит сухой прогон правил. Ничего не удаляется.
        </p>
        {settings && destination ? (
          <div className="mt-3 grid max-w-xl gap-3">
            <label className="grid gap-1 text-sm">
              Имя этого Склада
              <Input
                value={settings.settings.alias}
                onChange={(event) =>
                  setSettings({ ...settings, settings: { ...settings.settings, alias: event.target.value } })
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              PIN приёма, можно пустым
              <Input
                value={settings.settings.receivePin}
                onChange={(event) =>
                  setSettings({ ...settings, settings: { ...settings.settings, receivePin: event.target.value } })
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={destination.mode === "disk"}
                onChange={() =>
                  setSettings({
                    ...settings,
                    settings: {
                      ...settings.settings,
                      destination: { mode: "disk", diskId: settings.disks[0]?.id || "", folder: "Incoming" },
                    },
                  })
                }
              />
              Диск с полки и папка
            </label>
            {destination.mode === "disk" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  className="h-8 rounded-lg border bg-transparent px-2 text-sm"
                  value={destination.diskId}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      settings: { ...settings.settings, destination: { ...destination, diskId: event.target.value } },
                    })
                  }
                  aria-label="Диск назначения"
                >
                  {settings.disks.map((disk) => (
                    <option key={disk.id} value={disk.id}>
                      {disk.label} · {disk.filesystem}
                    </option>
                  ))}
                </select>
                <Input
                  value={destination.folder}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      settings: { ...settings.settings, destination: { ...destination, folder: event.target.value } },
                    })
                  }
                  aria-label="Папка на диске"
                />
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={destination.mode === "path"}
                onChange={() =>
                  setSettings({
                    ...settings,
                    settings: {
                      ...settings.settings,
                      destination: { mode: "path", os: "linux", path: destination.mode === "path" ? destination.path : "/tmp/sklad-localsend" },
                    },
                  })
                }
              />
              Абсолютный путь
            </label>
            {destination.mode === "path" ? (
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <select
                  className="h-8 rounded-lg border bg-transparent px-2 text-sm"
                  value={destination.os}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      settings: {
                        ...settings.settings,
                        destination: { ...destination, os: event.target.value as "darwin" | "win32" | "linux" },
                      },
                    })
                  }
                  aria-label="Система пути"
                >
                  <option value="darwin">macOS, APFS</option>
                  <option value="win32">Windows, NTFS</option>
                  <option value="linux">Linux</option>
                </select>
                <Input
                  value={destination.path}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      settings: { ...settings.settings, destination: { ...destination, path: event.target.value } },
                    })
                  }
                  aria-label="Абсолютный путь"
                />
              </div>
            ) : null}
            <Button type="button" variant="outline" onClick={() => void saveSettings()}>
              Сохранить каталог приёма
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
