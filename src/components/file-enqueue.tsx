"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import {
  DEMO_DISKS,
  DEMO_FILES,
  DISK_PAGE_SIZE,
  FILE_PAGE_SIZE,
  pageSlice,
  type DemoDisk,
  type DemoFile,
} from "@/lib/jobs/demo-catalog";
import { HOST_LABEL } from "@/lib/jobs/labels";
import type { EnqueueInput, PublicJob } from "@/lib/jobs/model";
import { cn } from "@/lib/utils";

export function FileEnqueue() {
  const [fileQuery, setFileQuery] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [diskPage, setDiskPage] = useState(0);
  const [selectedFile, setSelectedFile] = useState(DEMO_FILES[0]?.id ?? "");
  const [selectedDisk, setSelectedDisk] = useState(DEMO_DISKS[1]?.id ?? "");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const filtered = useMemo(() => {
    const needle = fileQuery.trim().toLowerCase();
    if (!needle) return DEMO_FILES;
    return DEMO_FILES.filter((file) => `${file.name} ${file.path}`.toLowerCase().includes(needle));
  }, [fileQuery]);
  const files = pageSlice(filtered, filePage, FILE_PAGE_SIZE);
  const disks = pageSlice(DEMO_DISKS, diskPage, DISK_PAGE_SIZE);
  const file = DEMO_FILES.find((item) => item.id === selectedFile) ?? null;
  const disk = DEMO_DISKS.find((item) => item.id === selectedDisk) ?? null;

  async function enqueue(input: EnqueueInput) {
    setPosting(true);
    try {
      const result = await api<{ job: PublicJob; created: boolean }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify(input),
      });
      toast.success(result.created ? "В очереди" : "Уже в очереди");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось поставить в очередь");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Поставить в очередь</h2>
        <Input
          value={fileQuery}
          onChange={(event) => {
            setFileQuery(event.target.value);
            setFilePage(0);
          }}
          placeholder="Поиск файлов"
          aria-label="Поиск файлов"
          className="h-7 max-w-48 text-xs"
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ul className="grid gap-1">
          {files.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", item.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => setSelectedFile(item.id)}
                className={cn(
                  "w-full rounded-lg border px-2 py-1.5 text-left",
                  selectedFile === item.id ? "border-primary bg-primary/10" : "border-border",
                )}
              >
                <span className="block truncate text-sm">{item.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{item.path}</span>
              </button>
            </li>
          ))}
        </ul>
        <ul className="grid content-start gap-1">
          {disks.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setSelectedDisk(item.id)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(item.id);
                }}
                onDragLeave={() => setDragOver((current) => (current === item.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(null);
                  const dropped = DEMO_FILES.find((entry) => entry.id === event.dataTransfer.getData("text/plain"));
                  if (!dropped) return;
                  const input = moveInput(dropped, item);
                  if (!input) {
                    toast.error("Перенос только внутри одного компьютера");
                    return;
                  }
                  void enqueue(input);
                }}
                className={cn(
                  "w-full rounded-lg border px-2 py-1.5 text-left",
                  dragOver === item.id ? "border-primary bg-primary/15" : selectedDisk === item.id ? "border-primary/70" : "border-border",
                )}
              >
                <span className="block text-sm">{item.label}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {HOST_LABEL[item.host]} · {item.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Файлы {filtered.length === 0 ? 0 : files.page * FILE_PAGE_SIZE + 1}–{files.page * FILE_PAGE_SIZE + files.items.length} из {filtered.length}
          {" · "}
          диски {disks.page * DISK_PAGE_SIZE + 1}–{disks.page * DISK_PAGE_SIZE + disks.items.length} из {DEMO_DISKS.length}
        </span>
        <span className="flex gap-1">
          <Button type="button" size="xs" variant="outline" disabled={files.page <= 0} onClick={() => setFilePage(files.page - 1)}>
            Файлы назад
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={files.page + 1 >= files.pages}
            onClick={() => setFilePage(files.page + 1)}
          >
            Файлы дальше
          </Button>
          <Button type="button" size="xs" variant="outline" disabled={disks.page <= 0} onClick={() => setDiskPage(disks.page - 1)}>
            Диски назад
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disks.page + 1 >= disks.pages}
            onClick={() => setDiskPage(disks.page + 1)}
          >
            Диски дальше
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={posting || !file || !disk}
          onClick={() => {
            if (!file || !disk) return;
            const input = moveInput(file, disk);
            if (!input) {
              toast.error("Перенос только внутри одного компьютера");
              return;
            }
            void enqueue(input);
          }}
        >
          Поставить в очередь
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={posting || file?.host !== "mac-local"}
          onClick={() => file && void enqueue(transcodeInput(file))}
        >
          В очередь: перекодировать
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={posting || file?.host !== "pc-agent"}
          onClick={() => file && void enqueue(compactInput(file))}
        >
          В очередь: сжать NTFS
        </Button>
        <Button type="button" variant="outline" disabled={posting || !disk} onClick={() => disk && void enqueue(indexInput(disk))}>
          В очередь: индекс
        </Button>
      </div>
    </div>
  );
}

function moveInput(file: DemoFile, disk: DemoDisk): EnqueueInput | null {
  if (file.host !== disk.host) return null;
  const destination = disk.host === "pc-agent" ? `${disk.path}\\${file.name}` : `${disk.path}/${file.name}`;
  if (destination === file.path) return null;
  return { kind: "move", host: file.host, source: file.path, destination, diskId: disk.id };
}

function transcodeInput(file: DemoFile): EnqueueInput {
  return {
    kind: "transcode",
    host: file.host,
    source: file.path,
    destination: file.path.replace(/\.[^./\\]+$/, "") + ".1080p.mp4",
    diskId: file.diskId,
    handbrakeProfile: "Apple 1080p30",
  };
}

function compactInput(file: DemoFile): EnqueueInput {
  return {
    kind: "compact",
    host: file.host,
    source: file.path,
    destination: file.path,
    diskId: file.diskId,
    compactAlgorithm: "XPRESS16K",
  };
}

function indexInput(disk: DemoDisk): EnqueueInput {
  return { kind: "index", host: disk.host, source: disk.path, diskId: disk.id };
}
