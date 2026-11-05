"use client";

import { MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import { osLabel, pluralTorrents } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { HostView } from "@/lib/qbittorrent/types";

export function HostSidebar({
  hosts,
  selectedId,
  onSelect,
  onAdd,
  onEdit,
  onChanged,
}: {
  hosts: HostView[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (host: HostView) => void;
  onChanged: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<HostView | null>(null);
  const [busy, setBusy] = useState(false);

  async function resetHost(host: HostView) {
    try {
      await api(`/api/hosts/${host.id}/reset`, { method: "POST" });
      toast.success("Демо-раздачи восстановлены");
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сбросить демо");
    }
  }

  async function removeHost() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api(`/api/hosts/${pendingDelete.id}`, { method: "DELETE" });
      toast.success(`Хост «${pendingDelete.name}» удалён`);
      if (selectedId === pendingDelete.id) onSelect("all");
      setPendingDelete(null);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось удалить хост");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex w-full flex-col border-border bg-sidebar md:h-full md:w-72 md:shrink-0 md:border-r">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Хосты</p>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus />
          Хост
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto px-3 pb-3 md:block md:flex-1 md:space-y-1 md:overflow-y-auto md:px-2">
        <HostButton
          active={selectedId === "all"}
          title="Все машины"
          meta={pluralTorrents(hosts.reduce((sum, host) => sum + host.torrentCount, 0))}
          online
          onClick={() => onSelect("all")}
        />
        {hosts.map((host) => (
          <div key={host.id} className="min-w-[220px] md:min-w-0">
            <HostButton
              active={selectedId === host.id}
              title={host.name}
              meta={`${host.kind === "mock" ? "демо · " : ""}${osLabel(host.os)} · ${pluralTorrents(host.torrentCount)}`}
              detail={host.error || (host.appVersion ? `qBittorrent ${host.appVersion}` : undefined)}
              detailError={Boolean(host.error)}
              online={host.online}
              onClick={() => onSelect(host.id)}
              menu={
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={`Действия: ${host.name}`} />}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {host.kind === "mock" ? (
                      <DropdownMenuItem onClick={() => void resetHost(host)}>
                        <RotateCcw />
                        Сбросить демо
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem onClick={() => onEdit(host)}>Изменить</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(host)}>
                          Удалить хост
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          </div>
        ))}
      </div>
      <p className="hidden px-4 pb-4 text-xs leading-5 text-muted-foreground md:block">
        Демо не ходит в сеть. Настоящий qBittorrent добавляется адресом вида http://192.168.1.20:8080.
      </p>
      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить хост?</DialogTitle>
            <DialogDescription>
              «{pendingDelete?.name}» исчезнет из Склада. Раздачи в самом qBittorrent останутся.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Отмена
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeHost()}>
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function HostButton({
  active,
  title,
  meta,
  detail,
  detailError,
  online,
  onClick,
  menu,
}: {
  active: boolean;
  title: string;
  meta: string;
  detail?: string;
  detailError?: boolean;
  online: boolean;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-1 rounded-lg px-2 py-2",
        active ? "bg-primary/15 ring-1 ring-primary/40" : "hover:bg-muted/70",
      )}
    >
      <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-seed" : "bg-destructive")} />
          <span className="truncate text-sm font-medium">{title}</span>
        </span>
        <span className="mt-1 block truncate pl-4 text-xs text-muted-foreground">{meta}</span>
        {detail ? (
          <span className={cn("mt-1 block truncate pl-4 font-mono text-[11px]", detailError ? "text-destructive" : "text-muted-foreground")}>
            {detail}
          </span>
        ) : null}
      </button>
      {menu}
    </div>
  );
}
