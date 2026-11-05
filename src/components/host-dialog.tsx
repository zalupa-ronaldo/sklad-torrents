"use client";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { HostOs, HostView, QbProbe } from "@/lib/qbittorrent/types";

const fieldClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

interface DraftPreset {
  id: string;
  label: string;
  path: string;
}

export function HostDialog({
  open,
  host,
  onClose,
  onSaved,
}: {
  open: boolean;
  host: HostView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(host);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8080");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [os, setOs] = useState<HostOs>("darwin");
  const [presets, setPresets] = useState<DraftPreset[]>([]);
  const [probe, setProbe] = useState<QbProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const session = open ? (host?.id ?? "create") : "closed";
  const [sessionKey, setSessionKey] = useState(session);
  if (session !== sessionKey) {
    setSessionKey(session);
    if (open) {
      setProbe(null);
      setPassword("");
      if (host) {
        setName(host.name);
        setBaseUrl(host.baseUrl);
        setUsername(host.username);
        setOs(host.os);
        setPresets(host.pathPresets.map((preset) => ({ ...preset })));
      } else {
        setName("");
        setBaseUrl("http://127.0.0.1:8080");
        setUsername("admin");
        setOs("darwin");
        setPresets([
          { id: crypto.randomUUID(), label: "Vault · загрузки", path: "/Volumes/vault/Downloads" },
          { id: crypto.randomUUID(), label: "Vault · PSP", path: "/Volumes/vault/PSP/Games/Downloads" },
        ]);
      }
    }
  }

  function updatePreset(id: string, patch: Partial<DraftPreset>) {
    setPresets((current) => current.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)));
  }

  async function test() {
    setBusy(true);
    setProbe(null);
    try {
      const result = await api<QbProbe>("/api/hosts/test", {
        method: "POST",
        body: JSON.stringify({ id: host?.id, baseUrl, username, password }),
      });
      setProbe(result);
      toast.success("Связь с qBittorrent есть");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Нет связи");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name,
        baseUrl,
        username,
        password,
        os,
        pathPresets: presets.filter((preset) => preset.path.trim()),
      };
      if (host) {
        await api(`/api/hosts/${host.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast.success("Хост обновлён");
      } else {
        await api("/api/hosts", { method: "POST", body: JSON.stringify(payload) });
        toast.success("Хост добавлен");
      }
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить хост");
    } finally {
      setBusy(false);
    }
  }

  function addDefaultPath() {
    if (!probe?.defaultSavePath) return;
    if (presets.some((preset) => preset.path === probe.defaultSavePath)) return;
    setPresets((current) => [
      ...current,
      { id: crypto.randomUUID(), label: "Каталог qBittorrent", path: probe.defaultSavePath },
    ]);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Хост qBittorrent" : "Новый хост"}</DialogTitle>
          <DialogDescription>
            Адрес Web UI, не ссылка на раздачу. Логин и пароль хранятся только в локальном файле Склада.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[65dvh] gap-3 overflow-y-auto pr-1">
          <Field label="Имя" value={name} onChange={setName} placeholder="Mac mini" />
          <Field label="Адрес Web UI" value={baseUrl} onChange={setBaseUrl} placeholder="http://192.168.1.20:8080" mono />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Пользователь" value={username} onChange={setUsername} placeholder="admin" />
            <div className="grid gap-1.5">
              <Label htmlFor="host-password">Пароль</Label>
              <Input
                id="host-password"
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder={editing ? "не менять" : "пароль Web UI"}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="host-os">Система</Label>
            <select id="host-os" className={fieldClass} value={os} onChange={(event) => setOs(event.target.value as HostOs)}>
              <option value="darwin">macOS — пути как /Volumes/vault</option>
              <option value="win32">Windows — пути как D:\Downloads</option>
            </select>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Каталоги для сохранения</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPresets((current) => [...current, { id: crypto.randomUUID(), label: "", path: "" }])}
              >
                Добавить
              </Button>
            </div>
            {presets.map((preset) => (
              <div key={preset.id} className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] gap-2">
                <Input
                  value={preset.label}
                  placeholder="Название"
                  aria-label="Название каталога"
                  onChange={(event) => updatePreset(preset.id, { label: event.target.value })}
                />
                <Input
                  value={preset.path}
                  placeholder={os === "win32" ? "D:\\Downloads" : "/Volumes/vault/Downloads"}
                  aria-label="Путь каталога"
                  className="font-mono text-xs"
                  spellCheck={false}
                  onChange={(event) => updatePreset(preset.id, { path: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPresets((current) => current.filter((item) => item.id !== preset.id))}
                >
                  Убрать
                </Button>
              </div>
            ))}
          </div>
          {probe ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-5">
              <p>
                Связь есть. qBittorrent {probe.appVersion}, WebAPI {probe.webapiVersion}.
              </p>
              <p className="font-mono text-[11px] text-muted-foreground">
                Каталог по умолчанию: {probe.defaultSavePath || "не задан"}
              </p>
              {probe.defaultSavePath ? (
                <button type="button" className="mt-1 text-primary" onClick={addDefaultPath}>
                  Добавить его в список
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void test()}>
            Проверить
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = label;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(mono && "font-mono text-xs")}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
