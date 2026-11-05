"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { buildHandBrakeArgv, suggestTranscodeOutput } from "@/addons/media-games/handbrake";
import { readToolQuery } from "@/addons/media-games/links";
import { formatArgv } from "@/addons/media-games/paths";
import { HANDBRAKE_PRESETS } from "@/addons/media-games/presets";
import type { ToolHostId, ToolOs } from "@/addons/media-games/types";
import { Field, Status, pathInputClass, selectClassName } from "@/app/tools/shell";
import { useToolsSnapshot } from "@/app/tools/use-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export function TranscodeForm() {
  const router = useRouter();
  const query = readToolQuery(useSearchParams());
  const { data, error, loading, refresh } = useToolsSnapshot(false);
  const [hostId, setHostId] = useState<ToolHostId>(query.hostId);
  const [presetId, setPresetId] = useState("fast-1080p");
  const [inputPath, setInputPath] = useState(query.path);
  const [outputPath, setOutputPath] = useState(() => suggestTranscodeOutput(query.os, query.path));
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Загрузка формы…</p>;
  if (error && !data) {
    return <Status title="Форма не открылась" body={error} action={<Button onClick={() => void refresh()}>Повторить</Button>} />;
  }
  if (!data) return null;

  const host = data.config.hosts.find((item) => item.id === hostId) ?? data.config.hosts[0];
  const probe = data.probes.find((item) => item.id === host.id);
  const preset = HANDBRAKE_PRESETS.find((item) => item.id === presetId) ?? HANDBRAKE_PRESETS[0];
  const os: ToolOs = host.os;
  let command = "";
  if (inputPath.trim() && outputPath.trim() && probe) {
    try {
      command = formatArgv(
        buildHandBrakeArgv({
          binary: probe.handbrakePath,
          inputPath: inputPath.trim(),
          outputPath: outputPath.trim(),
          preset: preset.handbrakeName,
        }),
      );
    } catch {
      command = "";
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api("/api/tools/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "transcode", hostId, inputPath, outputPath, presetId }),
      });
      toast.success("Перекодирование в очереди");
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
        <h2 className="text-lg font-medium">В HandBrake</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Задание вызывает уже установленный HandBrakeCLI. Склад его не включает.{" "}
          {probe?.handbrakeFound ? "Бинарник по настроенному пути найден." : "Бинарник не найден — в демо очередь всё равно пойдёт, команда запишется."}
        </p>
      </div>
      <Field label="Хост">
        <select
          className={selectClassName()}
          value={hostId}
          onChange={(event) => {
            const next = event.target.value as ToolHostId;
            setHostId(next);
            if (!outputPath && inputPath) setOutputPath(suggestTranscodeOutput(next === "pc-agent" ? "win32" : "darwin", inputPath));
          }}
        >
          {data.config.hosts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.os === "win32" ? "Windows" : "macOS"}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-2">
        <p className="text-sm">Пресет</p>
        <div className="flex flex-wrap gap-2">
          {HANDBRAKE_PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPresetId(item.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                presetId === item.id ? "border-primary bg-primary/15" : "border-border text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Исходный файл" hint={os === "win32" ? "Например D:\\Downloads\\Movie.mkv" : "Например /Volumes/vault/Cinema/Movie.mkv"}>
        <Input value={inputPath} onChange={(event) => setInputPath(event.target.value)} spellCheck={false} className={pathInputClass} />
      </Field>
      {host.libraryFolders.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {host.libraryFolders.map((folder) => (
            <button
              key={folder}
              type="button"
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
              onClick={() => setInputPath(folder)}
            >
              {folder}
            </button>
          ))}
        </div>
      ) : null}
      <Field label="Куда сохранить">
        <Input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} spellCheck={false} className={pathInputClass} />
      </Field>
      {command ? <p className="rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11px] break-all">{command}</p> : null}
      <Button disabled={busy || !inputPath.trim() || !outputPath.trim()} onClick={() => void submit()}>
        Поставить в очередь
      </Button>
    </div>
  );
}
