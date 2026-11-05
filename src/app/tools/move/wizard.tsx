"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { readToolQuery } from "@/addons/media-games/links";
import { planMove } from "@/addons/media-games/move";
import { suggestSsdDestination } from "@/addons/media-games/move-to-ssd/game-folder";
import { IndexFolderSearch } from "@/addons/media-games/move-to-ssd/index-source-picker";
import { pathLeaf, volumeKey } from "@/addons/media-games/paths";
import type { ToolHostId } from "@/addons/media-games/types";
import { Field, Status, pathInputClass, selectClassName } from "@/app/tools/shell";
import { useToolsSnapshot } from "@/app/tools/use-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

export function MoveWizard() {
  const router = useRouter();
  const query = readToolQuery(useSearchParams());
  const { data, error, loading, refresh } = useToolsSnapshot(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [hostId, setHostId] = useState<ToolHostId>(query.hostId);
  const [name, setName] = useState(query.name || (query.path ? pathLeaf(query.os, query.path) : ""));
  const [sourcePath, setSourcePath] = useState(query.path);
  const [destinationPath, setDestinationPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Загрузка мастера…</p>;
  if (error && !data) {
    return <Status title="Мастер не открылся" body={error} action={<Button onClick={() => void refresh()}>Повторить</Button>} />;
  }
  if (!data) return null;

  const host = data.config.hosts.find((item) => item.id === hostId) ?? data.config.hosts[0];
  const sourceVolume = volumeKey(host.os, sourcePath);
  const destVolume = volumeKey(host.os, destinationPath);
  const sameDisk = Boolean(sourceVolume && destVolume && sourceVolume === destVolume);

  function review() {
    try {
      planMove({
        hostId,
        os: host.os,
        name,
        sourcePath,
        destinationPath,
      });
      setFormError(null);
      setStep(2);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Проверьте пути");
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api("/api/tools/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "move", hostId, name, sourcePath, destinationPath }),
      });
      toast.success("Перенос в очереди. Источник пока на месте");
      router.push("/tools");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось поставить в очередь");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-2xl gap-5">
      <div>
        <h2 className="text-lg font-medium">Перенос игры</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          С HDD на SSD: на ПК это разные буквы диска, на Mac — внутренний каталог и /Volumes/…. Сначала копия, потом проверка числа файлов, объёма и хеша списка. Исходная папка не удаляется, пока проверка не сойдётся и вы отдельно не подтвердите удаление в очереди.
        </p>
      </div>
      {step === 1 ? (
        <>
          <Field label="Хост">
            <select className={selectClassName()} value={hostId} onChange={(event) => setHostId(event.target.value as ToolHostId)}>
              {data.config.hosts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.os === "win32" ? "Windows" : "macOS"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Название">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Control" />
          </Field>
          <IndexFolderSearch
            onPick={(folder) => {
              const pickedHost = folder.startsWith("/") ? "mac-local" : "pc-agent";
              const pickedOs = pickedHost === "pc-agent" ? "win32" : "darwin";
              setHostId(pickedHost);
              setSourcePath(folder);
              setName((current) => current || pathLeaf(pickedOs, folder));
              setDestinationPath((current) => current || suggestSsdDestination(folder));
            }}
          />
          <Field label="Откуда" hint={host.os === "win32" ? "D:\\Games\\Control" : "/Users/me/Games/Title"}>
            <Input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} spellCheck={false} className={pathInputClass} />
          </Field>
          <Field label="Куда" hint={host.os === "win32" ? "C:\\Games\\Control" : "/Volumes/vault/Games/Title"}>
            <Input value={destinationPath} onChange={(event) => setDestinationPath(event.target.value)} spellCheck={false} className={pathInputClass} />
          </Field>
          {host.libraryFolders.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {host.libraryFolders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
                  onClick={() => setDestinationPath((current) => current || folder)}
                >
                  {folder}
                </button>
              ))}
            </div>
          ) : null}
          {sameDisk ? (
            <p className="text-xs text-warn">Обе папки на одном томе. Для HDD → SSD обычно нужна другая буква или другой диск.</p>
          ) : null}
          {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          <Button disabled={!sourcePath.trim() || !destinationPath.trim()} onClick={review}>
            Дальше
          </Button>
        </>
      ) : (
        <>
          <div className="grid gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
            <p className="font-medium">{name || pathLeaf(host.os, sourcePath)}</p>
            <p className="font-mono text-xs break-all text-muted-foreground">{sourcePath}</p>
            <p className="font-mono text-xs break-all">→ {destinationPath}</p>
            <p>
              Источник не удаляется на этом шаге. После проверки в очереди появятся две кнопки: оставить папку или удалить её. Пока вы не подтвердите, флаг удаления выключен. Если проверка не сойдётся, удаление так и останется выключенным.
            </p>
            {host.os === "win32" ? (
              <Link
                className="text-primary hover:underline"
                href={`/tools/compress?host=pc-agent&os=win32&path=${encodeURIComponent(destinationPath)}`}
              >
                После переноса можно сжать папку назначения
              </Link>
            ) : (
              <p className="text-muted-foreground">Сжать CompactGUI отсюда нельзя: только Windows, NTFS.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setStep(1)}>
              Назад
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              Поставить в очередь, источник не удалять
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
