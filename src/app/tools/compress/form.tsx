"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { COMPACT_GUI_NOTE, buildCompactArgv, compressAvailability } from "@/addons/media-games/compact";
import { readToolQuery } from "@/addons/media-games/links";
import { formatArgv } from "@/addons/media-games/paths";
import { COMPACT_ALGORITHMS } from "@/addons/media-games/presets";
import type { CompactAlgorithm, ToolHostId } from "@/addons/media-games/types";
import { Field, Status, pathInputClass, selectClassName } from "@/app/tools/shell";
import { useToolsSnapshot } from "@/app/tools/use-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export function CompressForm() {
  const router = useRouter();
  const query = readToolQuery(useSearchParams());
  const { data, error, loading, refresh } = useToolsSnapshot(false);
  const [hostId, setHostId] = useState<ToolHostId>(query.hostId);
  const [folderPath, setFolderPath] = useState(query.path);
  const [algorithm, setAlgorithm] = useState<CompactAlgorithm>("LZX");
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  if (error && !data) {
    return <Status title="Форма не открылась" body={error} action={<Button onClick={() => void refresh()}>Повторить</Button>} />;
  }
  if (!data) return null;

  const host = data.config.hosts.find((item) => item.id === hostId) ?? data.config.hosts[0];
  const availability = compressAvailability(host.os, folderPath);
  const macBlocked = host.os !== "win32";
  const pathBlocked = folderPath.trim().length > 0 && !availability.ok;
  const blocked = macBlocked || !availability.ok;
  const reason = macBlocked ? "Только Windows, NTFS." : availability.ok ? null : availability.reason;
  let command = "";
  if (host.os === "win32" && availability.ok) {
    try {
      command = formatArgv(
        buildCompactArgv({
          os: "win32",
          binary: host.compactPath || "C:\\Windows\\System32\\compact.exe",
          folder: folderPath,
          algorithm,
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
        body: JSON.stringify({ kind: "compress", hostId, folderPath, algorithm }),
      });
      toast.success("Сжатие в очереди");
      router.push("/tools");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-2xl gap-5">
      <div>
        <h2 className="text-lg font-medium">Сжать CompactGUI</h2>
        <p className="mt-1 text-sm text-muted-foreground">{COMPACT_GUI_NOTE}</p>
      </div>
      {macBlocked || pathBlocked ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="status">
          {reason}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Папка на NTFS. Оценка экономии появится в очереди, когда демо или агент её посчитает.</p>
      )}
      <Field label="Хост">
        <select className={selectClassName()} value={hostId} onChange={(event) => setHostId(event.target.value as ToolHostId)}>
          {data.config.hosts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.os === "win32" ? "Windows" : "macOS, недоступно"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Папка" hint="D:\Games\Control или \\server\share\Games. Не /Volumes/vault.">
        <Input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} spellCheck={false} className={pathInputClass} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground" onClick={() => { setHostId("pc-agent"); setFolderPath("D:\\Games\\Control"); }}>
          D:\Games\Control
        </button>
        <button type="button" className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground" onClick={() => { setHostId("mac-local"); setFolderPath("/Volumes/vault/Games/Title"); }}>
          /Volumes/vault — только посмотреть отказ
        </button>
      </div>
      <div className="grid gap-2">
        <p className="text-sm">Алгоритм</p>
        <div className="flex flex-wrap gap-2">
          {COMPACT_ALGORITHMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setAlgorithm(item.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                algorithm === item.id ? "border-primary bg-primary/15" : "border-border text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{COMPACT_ALGORITHMS.find((item) => item.id === algorithm)?.hint}</p>
      </div>
      {command ? <p className="rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11px] break-all">{command}</p> : null}
      <Button disabled={busy || blocked} onClick={() => void submit()}>
        Сжать CompactGUI
      </Button>
    </div>
  );
}
