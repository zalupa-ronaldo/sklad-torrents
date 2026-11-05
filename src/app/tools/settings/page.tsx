"use client";

import { useState } from "react";
import { toast } from "sonner";

import { COMPACT_GUI_NOTE } from "@/addons/media-games/compact";
import { HANDBRAKE_DISCOVERY_NOTE } from "@/addons/media-games/handbrake";
import type { ToolHostConfig, ToolHostId, ToolsConfig } from "@/addons/media-games/types";
import { Field, Status, pathInputClass } from "@/app/tools/shell";
import { useToolsSnapshot } from "@/app/tools/use-tools";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

export default function SettingsPage() {
  const { data, error, loading, refresh } = useToolsSnapshot(false);
  const [draft, setDraft] = useState<ToolsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  if (data && !draft) setDraft(structuredClone(data.config));

  if (loading && !data) return <p className="text-sm text-muted-foreground">Загружаем настройки…</p>;
  if (error && !data) {
    return <Status title="Настройки не открылись" body={error} action={<Button onClick={() => void refresh()}>Повторить</Button>} />;
  }
  if (!data || !draft) return null;

  function patchHost(id: ToolHostId, patch: Partial<ToolHostConfig>) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        hosts: current.hosts.map((host) => (host.id === id ? { ...host, ...patch } : host)),
      };
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api<NonNullable<typeof data>>("/api/tools/config", { method: "PUT", body: JSON.stringify(draft) });
      setDraft(structuredClone(next.config));
      toast.success("Настройки сохранены");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <div>
        <h2 className="text-lg font-medium">Пути и агент</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Стартовые пути можно заменить. Они пишутся в data/ на машине, где запущен Склад, и в git не попадают.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={draft.demoMode} onCheckedChange={(value) => setDraft({ ...draft, demoMode: value === true })} />
        <span>
          Демо-режим. Очередь и текст команд есть, HandBrake и compact.exe не запускаются. Выключите его, только когда программы установлены, а агент на ПК уже отвечает.
        </span>
      </label>
      {draft.hosts.map((host) => {
        const probe = data.probes.find((item) => item.id === host.id);
        return (
          <section key={host.id} className="grid gap-3 rounded-xl border bg-card px-4 py-4">
            <h3 className="font-medium">{host.os === "win32" ? "Windows PC" : "Mac mini"}</h3>
            <Field label="Имя">
              <Input value={host.name} onChange={(event) => patchHost(host.id, { name: event.target.value })} />
            </Field>
            <Field label="HandBrakeCLI" hint={HANDBRAKE_DISCOVERY_NOTE[host.os]}>
              <Input
                value={host.handbrakePath}
                onChange={(event) => patchHost(host.id, { handbrakePath: event.target.value })}
                spellCheck={false}
                className={pathInputClass}
              />
            </Field>
            <Field
              label={host.os === "win32" ? "Запасной exe" : "Второй путь или flatpak id"}
              hint={probe?.handbrakeFound ? "Сохранённый путь находится." : "Сохранённый путь сейчас не найден."}
            >
              <Input
                value={host.handbrakeExtra}
                onChange={(event) => patchHost(host.id, { handbrakeExtra: event.target.value })}
                spellCheck={false}
                className={pathInputClass}
                placeholder={host.os === "win32" ? "Не Flatpak" : "fr.handbrake.ghb или /opt/homebrew/bin/HandBrakeCLI"}
              />
            </Field>
            {host.os === "win32" ? (
              <>
                <Field label="Адрес агента" hint="http://192.168.1.50:4730 — машина, где запущен agents/pc-agent. Без прокси.">
                  <Input
                    value={host.agentUrl ?? ""}
                    onChange={(event) => patchHost(host.id, { agentUrl: event.target.value })}
                    spellCheck={false}
                    className={pathInputClass}
                  />
                </Field>
                <Field label="compact.exe" hint={COMPACT_GUI_NOTE}>
                  <Input
                    value={host.compactPath}
                    onChange={(event) => patchHost(host.id, { compactPath: event.target.value })}
                    spellCheck={false}
                    className={pathInputClass}
                  />
                </Field>
                <Field label="CompactGUI (только справка, не вызывается)">
                  <Input
                    value={host.compactGuiPath}
                    onChange={(event) => patchHost(host.id, { compactGuiPath: event.target.value })}
                    spellCheck={false}
                    className={pathInputClass}
                  />
                </Field>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Сжатие NTFS на Mac выключено: только Windows.</p>
            )}
            <Field label="Каталоги библиотеки" hint="По одному пути на строку. Подставляются в формы.">
              <textarea
                value={host.libraryFolders.join("\n")}
                onChange={(event) => patchHost(host.id, { libraryFolders: event.target.value.split("\n") })}
                spellCheck={false}
                rows={4}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </Field>
          </section>
        );
      })}
      <Button disabled={busy} onClick={() => void save()}>
        Сохранить
      </Button>
    </div>
  );
}
