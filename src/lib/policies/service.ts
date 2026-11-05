import type { GameSubtype } from "@/lib/content/types";
import { isContentKind, isGameSubtype } from "@/lib/content/types";
import { loadDriveCatalog } from "@/lib/drives/catalog";
import { toPolicyDisk } from "@/lib/policies/disks";
import { enqueuePolicyJob, loadPolicyJobs, type PolicyJob } from "@/lib/policies/jobs";
import { PRESET_LIST } from "@/lib/policies/presets";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertHash } from "@/lib/qbittorrent/paths";
import { clientFor, getDashboard, relocateTorrent, requireHost } from "@/lib/qbittorrent/service";
import { buildDryRun, dryRunFingerprint, enableAutomation } from "@/lib/policies/dry-run";
import {
  applyNamedPreset,
  clearOverride,
  loadOverrides,
  loadPolicy,
  overrideRecord,
  saveCustomRules,
  saveOverride,
  savePolicy,
} from "@/lib/policies/store";
import type { DryRunInput, DryRunResult, PolicyDocument, PolicyHost, PolicyTorrent, PresetId, TorrentPlacement } from "@/lib/policies/types";

export async function getPolicyView() {
  const [policy, catalog, dashboard, jobs] = await Promise.all([
    loadPolicy(),
    loadDriveCatalog(),
    getDashboard(),
    loadPolicyJobs(),
  ]);
  const hosts: PolicyHost[] = dashboard.hosts.map((host) => ({
    id: host.id,
    name: host.name,
    os: host.os,
    online: host.online,
  }));
  return {
    policy,
    hosts,
    jobs,
    presets: PRESET_LIST.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description })),
    disks: catalog.map((disk) => {
      const hostId = disk.mounts.find((mount) => mount.hostId)?.hostId;
      const view = toPolicyDisk(disk, hosts.find((host) => host.id === hostId)?.name ?? "");
      return {
        id: view.id,
        label: view.label,
        online: view.online,
        filesystem: view.filesystem,
        mountPath: view.mountPath,
        hostId: view.hostId,
        hostName: view.hostName,
        os: view.os,
      };
    }),
  };
}

export async function updatePolicy(body: { presetId?: string; rules?: unknown }): Promise<PolicyDocument> {
  const current = await loadPolicy();
  const presetId = body.presetId;
  let next = current;
  if (presetId && presetId !== "custom" && isNamedPreset(presetId)) {
    next = applyNamedPreset(current, presetId);
  } else if (body.rules) {
    next = saveCustomRules(current, body.rules);
  } else {
    throw new QbittorrentError("validation", "Нечего сохранять.");
  }
  await savePolicy(next);
  return next;
}

export async function runPreview(rules?: unknown): Promise<
  DryRunResult & { fingerprint: string; automationEnabled: boolean; previewAt: number; policy: PolicyDocument }
> {
  let policy = await loadPolicy();
  if (rules) policy = saveCustomRules(policy, rules);
  const input = await loadDryRunInput(policy);
  const result = buildDryRun(input);
  const fingerprint = dryRunFingerprint(input);
  const previewAt = Date.now();
  const next = { ...policy, preview: { fingerprint, at: previewAt } };
  await savePolicy(next);
  return { ...result, fingerprint, automationEnabled: next.automationEnabled, previewAt, policy: next };
}

export async function setAutomationEnabled(enabled: boolean, fingerprint: string): Promise<PolicyDocument> {
  const policy = await loadPolicy();
  if (!enabled) {
    const next = { ...policy, automationEnabled: false };
    await savePolicy(next);
    return next;
  }
  const input = await loadDryRunInput(policy);
  const current = dryRunFingerprint(input);
  const next = enableAutomation(policy, fingerprint, current);
  await savePolicy(next);
  return next;
}

export async function applyPolicyPass(fingerprint: string): Promise<{
  moves: { hash: string; location: string; via: "qbittorrent.setLocation" }[];
  jobs: PolicyJob[];
  deletesSource: false;
}> {
  const policy = await loadPolicy();
  if (!policy.automationEnabled) {
    throw new QbittorrentError("validation", "Проход доступен только при включённой автоматике. Включение само ничего не удаляет.");
  }
  const input = await loadDryRunInput(policy);
  const current = dryRunFingerprint(input);
  if (!policy.preview || policy.preview.fingerprint !== fingerprint || fingerprint !== current) {
    throw new QbittorrentError("validation", "Прогон устарел. Запустите его снова.");
  }
  const dry = buildDryRun(input);
  const moves: { hash: string; location: string; via: "qbittorrent.setLocation" }[] = [];
  const jobs: PolicyJob[] = [];
  for (const row of dry.rows) {
    for (const step of row.steps) {
      if (step.type === "setLocation") {
        await relocateTorrent(row.hostId, row.hash, step.location);
        moves.push({ hash: row.hash, location: step.location, via: "qbittorrent.setLocation" });
      }
      if (step.type === "queue-handbrake") {
        jobs.push(
          await enqueuePolicyJob({
            kind: "handbrake",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: step.outputPath,
            note: `Профиль «${step.presetName}». Исходник не удаляется.`,
          }),
        );
      }
      if (step.type === "queue-compact") {
        jobs.push(
          await enqueuePolicyJob({
            kind: "compact",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: step.outputPath,
            note: "Отдельная сжатая копия на NTFS. Исходник не удаляется.",
          }),
        );
      }
      if (step.type === "index" && step.profile !== "none") {
        jobs.push(
          await enqueuePolicyJob({
            kind: "index",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: row.destinationPath,
            note: step.profile === "ntfs-mft" ? "Индекс NTFS MFT" : "Обычный обход каталога",
          }),
        );
      }
    }
  }
  return { moves, jobs, deletesSource: false };
}

export async function setContentOverride(input: {
  hostId: string;
  hash: string;
  kind?: string;
  gameSubtype?: string | null;
  clear?: boolean;
}): Promise<void> {
  const hash = assertHash(input.hash);
  await requireHost(input.hostId);
  if (input.clear) {
    await clearOverride(input.hostId, hash);
  } else {
    if (!isContentKind(input.kind)) throw new QbittorrentError("validation", "Выберите тип.");
    const subtype: GameSubtype | null =
      input.kind === "game" ? (isGameSubtype(input.gameSubtype) ? input.gameSubtype : "other") : null;
    await saveOverride(overrideRecord(input.hostId, hash, input.kind, subtype));
  }
  const policy = await loadPolicy();
  await savePolicy({ ...policy, preview: null, automationEnabled: false });
}

export async function placementFor(hostId: string, hash: string): Promise<TorrentPlacement> {
  const safe = assertHash(hash);
  const policy = await loadPolicy();
  const input = await loadDryRunInput(policy);
  const dry = buildDryRun(input);
  const row = dry.rows.find((item) => item.hostId === hostId && item.hash === safe);
  if (!row) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  return {
    kind: row.kind,
    gameSubtype: row.gameSubtype,
    reason: row.reason,
    detail: row.detail,
    diskLabel: row.diskLabel,
    diskOnline: row.diskOnline,
    folder: row.folder,
    destinationPath: row.destinationPath,
    indexProfile: row.indexProfile,
    postAction: row.postAction,
    postActionRequested: row.postActionRequested,
    postUnavailable: row.postUnavailable,
    postNote: row.postNote,
    indexNote: row.indexNote,
    scheduler: row.scheduler,
  };
}

export async function loadDryRunInput(policy: PolicyDocument): Promise<DryRunInput> {
  const [dashboard, overrides, disks] = await Promise.all([getDashboard(), loadOverrides(), loadDriveCatalog()]);
  const hosts: PolicyHost[] = dashboard.hosts.map((host) => ({
    id: host.id,
    name: host.name,
    os: host.os,
    online: host.online,
  }));
  const byHost = new Map<string, typeof dashboard.torrents>();
  for (const torrent of dashboard.torrents) {
    const list = byHost.get(torrent.hostId) ?? [];
    list.push(torrent);
    byHost.set(torrent.hostId, list);
  }
  const torrents: PolicyTorrent[] = [];
  for (const [hostId, list] of byHost) {
    const host = await requireHost(hostId);
    const online = dashboard.hosts.find((item) => item.id === hostId)?.online === true;
    const files = new Map<string, { name: string; size: number }[]>();
    if (online) {
      try {
        const client = clientFor(host);
        await client.login();
        for (const torrent of list) {
          try {
            const entries = await client.listFiles(torrent.hash);
            files.set(
              torrent.hash,
              entries.map((file) => ({ name: file.name, size: file.size })),
            );
          } catch {
            files.set(torrent.hash, []);
          }
        }
      } catch {
        // Host dropped out between the dashboard read and the file listing.
      }
    }
    for (const torrent of list) {
      torrents.push({
        hostId,
        hostName: torrent.hostName,
        hash: torrent.hash,
        name: torrent.name,
        savePath: torrent.savePath,
        progress: torrent.progress,
        state: torrent.state,
        addedOn: torrent.addedOn,
        files: files.get(torrent.hash) ?? [],
      });
    }
  }
  return { torrents, hosts, disks, rules: policy.rules, overrides };
}

function isNamedPreset(value: string): value is Exclude<PresetId, "custom"> {
  return value === "shelf" || value === "index-only" || value === "handbrake-cinema";
}
