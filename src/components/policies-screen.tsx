"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import { INDEX_LABEL, KIND_LABEL, POST_LABEL, REASON_LABEL, kindLabel } from "@/lib/content/labels";
import { CONTENT_KINDS, type ContentKind, type IndexProfile, type PostAction } from "@/lib/content/types";
import type { DryRunRow, HandbrakeSettings, PolicyDocument, PolicyHost, PolicyRules, PresetId, TypeRule } from "@/lib/policies/types";

interface DiskOption {
  id: string;
  label: string;
  online: boolean;
  filesystem: "ntfs" | "apfs" | "exfat" | "other";
  mountPath: string;
  hostId: string;
  hostName: string;
  os: "darwin" | "win32";
}

interface PolicyJobView {
  id: string;
  kind: "handbrake" | "compact" | "index";
  status: "queued" | "done";
  torrentName: string;
  outputPath: string;
  deleteSource: boolean;
  note: string;
}

interface PolicyPayload {
  policy: PolicyDocument;
  hosts: PolicyHost[];
  presets: { id: Exclude<PresetId, "custom">; name: string; description: string }[];
  disks: DiskOption[];
  jobs: PolicyJobView[];
}

interface PreviewPayload {
  rows: DryRunRow[];
  fingerprint: string;
  automationEnabled: boolean;
  policy: PolicyDocument;
  deletesSource: false;
}

const controlClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function PoliciesScreen() {
  const [payload, setPayload] = useState<PolicyPayload | null>(null);
  const [rules, setRules] = useState<PolicyRules | null>(null);
  const [presetId, setPresetId] = useState<PresetId>("shelf");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await api<PolicyPayload>("/api/policies");
    setPayload(next);
    setRules(next.policy.rules);
    setPresetId(next.policy.presetId);
    setError(null);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось открыть правила");
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  function edit(kind: ContentKind, patch: Partial<TypeRule>) {
    setRules((current) => (current ? { ...current, [kind]: { ...current[kind], ...patch } } : current));
    setPresetId("custom");
    setStale(true);
  }

  async function applyPreset(id: Exclude<PresetId, "custom">) {
    setBusy(true);
    try {
      await api("/api/policies", { method: "PUT", body: JSON.stringify({ presetId: id }) });
      setPreview(null);
      setStale(true);
      await load();
      toast.success("Пресет подставлен. Автоматика сама не включилась");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось применить пресет");
    } finally {
      setBusy(false);
    }
  }

  async function runDryRun() {
    if (!rules) return;
    setBusy(true);
    try {
      const next = await api<PreviewPayload>("/api/policies/preview", {
        method: "POST",
        body: JSON.stringify(stale ? { rules } : {}),
      });
      setPreview(next);
      setStale(false);
      setRules(next.policy.rules);
      setPresetId(next.policy.presetId);
      setPayload((current) => (current ? { ...current, policy: next.policy } : current));
      toast.success("Сухой прогон готов. Ничего не удалено и не перенесено");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Прогон не собрался");
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!preview && enabled) return;
    setBusy(true);
    try {
      const result = await api<{ policy: PolicyDocument }>("/api/policies/automation", {
        method: "POST",
        body: JSON.stringify({ enabled, fingerprint: preview?.fingerprint ?? "" }),
      });
      setPayload((current) => (current ? { ...current, policy: result.policy } : current));
      toast.success(enabled ? "Автоматика включена" : "Автоматика выключена");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Переключатель не сдвинулся");
    } finally {
      setBusy(false);
    }
  }

  async function applyPass() {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api<{ jobs: PolicyJobView[]; moves: unknown[]; deletesSource: false }>("/api/policies/apply", {
        method: "POST",
        body: JSON.stringify({ fingerprint: preview.fingerprint }),
      });
      if (result.deletesSource) throw new Error("Проход не должен удалять исходники");
      toast.success("Перенос через setLocation, обработка поставлена в очередь");
      const jobs = await api<{ jobs: PolicyJobView[] }>("/api/policies/jobs");
      setPayload((current) => (current ? { ...current, jobs: jobs.jobs } : current));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Проход не выполнен");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(job: PolicyJobView, checked: boolean) {
    if (!checked) return;
    try {
      await api(`/api/policies/jobs/${job.id}`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      toast.success("Подтверждение записано. Демо файлы не стирает");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Исходник не удалён");
    }
  }

  const policy = payload?.policy;
  const enabled = policy?.automationEnabled === true;
  const canEnable = Boolean(preview) && !stale && !enabled;

  return (
    <AppShell current="policies" subtitle="Куда класть раздачи по типу">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!payload || !rules || !policy ? (
        <p className="text-sm text-muted-foreground">Загружаем правила…</p>
      ) : (
        <div className="grid gap-6">
          <section className="grid gap-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Правила раскладки</h1>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  Сначала тип, потом диск и папка. Автоматика по умолчанию выключена: без сухого прогона она не
                  включается и ничего не удаляет.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Автоматика раскладки"
                disabled={busy || (!enabled && !canEnable)}
                onClick={() => void setEnabled(!enabled)}
                className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <span className={enabled ? "size-2 rounded-full bg-primary" : "size-2 rounded-full bg-muted-foreground"} />
                {enabled ? "Автоматика включена" : "Автоматика выключена"}
              </button>
            </div>
            {stale ? (
              <p className="rounded-lg bg-warn/15 px-3 py-2 text-sm text-warn">
                Правила изменились, сухой прогон устарел. Включить автоматику можно только после нового прогона.
              </p>
            ) : null}
            {!preview && !enabled ? (
              <p className="text-sm text-muted-foreground">
                Переключатель заблокирован, пока на экране нет свежего прогона.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Удаление исходника сюда не входит. Отдельная галочка ниже выключена и не связана с этим переключателем.
              Готовая раздача переезжает только через qBittorrent setLocation, раздача продолжается.
            </p>
          </section>

          <section className="grid gap-3">
            <h2 className="text-sm font-medium">Пресеты</h2>
            <div className="grid gap-2 lg:grid-cols-3">
              {payload.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={presetId === preset.id}
                  disabled={busy}
                  onClick={() => void applyPreset(preset.id)}
                  className={
                    presetId === preset.id
                      ? "rounded-xl border border-primary bg-primary/10 p-3 text-left"
                      : "rounded-xl border bg-card p-3 text-left hover:bg-muted/40"
                  }
                >
                  <span className="block text-sm font-medium">{preset.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{preset.description}</span>
                </button>
              ))}
            </div>
            {presetId === "custom" ? <p className="text-xs text-muted-foreground">Свои правила</p> : null}
          </section>

          <section className="grid gap-3">
            {CONTENT_KINDS.map((kind) => (
              <RuleCard
                key={kind}
                kind={kind}
                rule={rules[kind]}
                disks={payload.disks}
                hosts={payload.hosts}
                onChange={(patch) => edit(kind, patch)}
              />
            ))}
          </section>

          <section className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => void runDryRun()}>
              Сухой прогон
            </Button>
            <Button variant="outline" disabled={busy || !enabled || stale || !preview} onClick={() => void applyPass()}>
              Поставить в очередь
            </Button>
            <Link href="/progress" className="text-sm text-primary hover:underline">
              Открыть прогресс
            </Link>
          </section>

          {preview ? (
            <section className="grid gap-3">
              <h2 className="text-sm font-medium">Куда ляжет каждая раздача</h2>
              <p className="text-xs text-muted-foreground">
                В шагах нет удаления. На одном физическом диске качает только одна раздача. Если диск не в сети, маршрут ждёт.
              </p>
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead className="border-b text-xs tracking-wide text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2 font-medium">Раздача</th>
                      <th className="px-3 py-2 font-medium">Тип</th>
                      <th className="px-3 py-2 font-medium">Почему</th>
                      <th className="px-3 py-2 font-medium">Диск</th>
                      <th className="px-3 py-2 font-medium">Папка</th>
                      <th className="px-3 py-2 font-medium">Индекс</th>
                      <th className="px-3 py-2 font-medium">После</th>
                      <th className="px-3 py-2 font-medium">Очередь</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={`${row.hostId}:${row.hash}`} className="border-b last:border-0">
                        <td className="px-3 py-2">{row.name}</td>
                        <td className="px-3 py-2">{kindLabel(row.kind, row.gameSubtype)}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {REASON_LABEL[row.reason]}
                          <span className="mt-1 block text-xs">{row.detail}</span>
                        </td>
                        <td className="px-3 py-2">
                          {row.diskLabel}
                          <span className={row.diskOnline ? "block text-xs text-muted-foreground" : "block text-xs text-warn"}>
                            {row.diskOnline ? "в сети" : "нет в сети"}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{row.folder || "—"}</td>
                        <td className="px-3 py-2">{INDEX_LABEL[row.indexProfile]}</td>
                        <td className="px-3 py-2">
                          {row.postUnavailable ? "недоступно" : POST_LABEL[row.postAction]}
                          {row.postNote ? <span className="mt-1 block text-xs text-muted-foreground">{row.postNote}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{queueLabel(row.scheduler)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">Запустите сухой прогон, чтобы увидеть диск, папку, индекс и обработку.</p>
          )}

          <section className="grid gap-3">
            <h2 className="text-sm font-medium">Задания обработки</h2>
            <p className="text-xs text-muted-foreground">
              HandBrake и сжатие остаются в очереди и пишут новый путь. Галочка удаления исходника выключена, пока результат не готов, и не включается вместе с автоматикой.
            </p>
            {payload.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Пока пусто. После прохода они появятся и на странице прогресса.</p>
            ) : (
              <ul className="grid gap-2">
                {payload.jobs.map((job) => (
                  <li key={job.id} className="rounded-xl border px-3 py-3">
                    <p className="text-sm font-medium">{job.torrentName}</p>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{job.outputPath}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.kind === "handbrake" ? "HandBrake" : job.kind === "compact" ? "Сжатие NTFS" : "Индекс"} · {job.status === "queued" ? "в очереди" : "готово"}
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={job.deleteSource}
                        disabled={job.status !== "done" || job.deleteSource}
                        onCheckedChange={(checked) => void confirmDelete(job, checked === true)}
                      />
                      Удалить исходник после проверки
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function RuleCard({
  kind,
  rule,
  disks,
  hosts,
  onChange,
}: {
  kind: ContentKind;
  rule: TypeRule;
  disks: DiskOption[];
  hosts: PolicyHost[];
  onChange: (patch: Partial<TypeRule>) => void;
}) {
  const disk = disks.find((item) => item.id === rule.diskId) ?? null;
  const filesystem = disk?.filesystem ?? null;
  const ntfs = filesystem === "ntfs";
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium">{KIND_LABEL[kind]}</h3>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Диск
          <select
            aria-label={`Диск для ${KIND_LABEL[kind]}`}
            className={controlClass}
            value={rule.diskId ?? ""}
            onChange={(event) => onChange({ diskId: event.target.value || null })}
          >
            {disks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.filesystem.toUpperCase()} · {item.online ? "в сети" : "нет в сети"}
              </option>
            ))}
            <option value="">Свой путь…</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Папка
          <input
            aria-label={`Папка для ${KIND_LABEL[kind]}`}
            className={controlClass}
            value={rule.folder}
            onChange={(event) => onChange({ folder: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Индексация
          <select
            aria-label={`Индекс для ${KIND_LABEL[kind]}`}
            className={controlClass}
            value={rule.indexProfile}
            onChange={(event) => onChange({ indexProfile: event.target.value as IndexProfile })}
          >
            <option value="none">Не индексировать</option>
            <option value="walk">Обычный обход</option>
            <option value="ntfs-mft" disabled={!ntfs && Boolean(disk)}>
              NTFS MFT
            </option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          После загрузки
          <select
            aria-label={`Обработка для ${KIND_LABEL[kind]}`}
            className={controlClass}
            value={rule.postAction}
            onChange={(event) => onChange({ postAction: event.target.value as PostAction })}
          >
            <option value="none">Без обработки</option>
            <option value="compact" disabled={!ntfs}>
              Сжатие NTFS
            </option>
            <option value="handbrake">HandBrake</option>
          </select>
        </label>
      </div>
      {!rule.diskId ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Хост
            <select
              aria-label={`Хост для ${KIND_LABEL[kind]}`}
              className={controlClass}
              value={rule.customHostId}
              onChange={(event) => onChange({ customHostId: event.target.value })}
            >
              <option value="">Выберите хост</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Свой путь
            <input
              aria-label={`Свой путь для ${KIND_LABEL[kind]}`}
              className={`${controlClass} font-mono text-xs`}
              value={rule.customPath}
              placeholder={hosts.find((host) => host.id === rule.customHostId)?.os === "win32" ? "D:\\Library" : "/Volumes/vault/Library"}
              onChange={(event) => onChange({ customPath: event.target.value })}
            />
          </label>
        </div>
      ) : null}
      {disk && !ntfs ? (
        <p className="text-xs text-muted-foreground">
          {disk.filesystem === "apfs"
            ? "APFS: сжатие CompactGUI и NTFS MFT выключены. HandBrake можно."
            : "Сжатие CompactGUI и MFT доступны только на NTFS."}
        </p>
      ) : null}
      {kind === "game" ? (
        <p className="text-xs text-muted-foreground">Сжатие, если оно доступно, ставится в очередь только после завершённого переноса. Исходник остаётся.</p>
      ) : null}
      {rule.postAction === "handbrake" ? (
        <HandbrakeFields
          settings={rule.handbrake}
          onChange={(handbrake) => onChange({ handbrake })}
        />
      ) : null}
    </article>
  );
}

function HandbrakeFields({
  settings,
  onChange,
}: {
  settings: HandbrakeSettings;
  onChange: (settings: HandbrakeSettings) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Профиль
        <input
          aria-label="Имя профиля HandBrake"
          className={controlClass}
          value={settings.presetName}
          onChange={(event) => onChange({ ...settings, presetName: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Качество
        <select
          aria-label="Режим качества HandBrake"
          className={controlClass}
          value={settings.qualityMode}
          onChange={(event) => onChange({ ...settings, qualityMode: event.target.value === "bitrate" ? "bitrate" : "rf" })}
        >
          <option value="rf">RF</option>
          <option value="bitrate">Битрейт, кбит/с</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Значение
        <input
          aria-label="Значение качества HandBrake"
          className={controlClass}
          type="number"
          value={settings.quality}
          onChange={(event) => onChange({ ...settings, quality: Number(event.target.value) })}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Контейнер
        <select
          aria-label="Контейнер HandBrake"
          className={controlClass}
          value={settings.container}
          onChange={(event) => onChange({ ...settings, container: event.target.value === "mp4" ? "mp4" : "mkv" })}
        >
          <option value="mkv">mkv</option>
          <option value="mp4">mp4</option>
        </select>
      </label>
    </div>
  );
}

function queueLabel(role: DryRunRow["scheduler"]): string {
  if (role === "active") return "качает";
  if (role === "queued") return "ждёт слот";
  if (role === "waiting-offline") return "диск не в сети";
  return "не качает";
}
