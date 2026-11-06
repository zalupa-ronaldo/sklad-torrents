import { readCatalog } from "@/addons/drives/store";
import { rulesFromDiscovered } from "@/lib/policies/auto-routes";
import { ensureBaseline, isAutoEligible, markManagedMany } from "@/lib/policies/auto-managed";
import { enqueuePolicyJob } from "@/lib/policies/jobs";
import { loadDryRunInput } from "@/lib/policies/service";
import { buildDryRun, dryRunFingerprint } from "@/lib/policies/dry-run";
import { loadPolicy, savePolicy } from "@/lib/policies/store";
import type { PolicyDocument } from "@/lib/policies/types";
import { getDashboard, relocateTorrent } from "@/lib/qbittorrent/service";

let ticking = false;
let lastTick = 0;
let cachedRoutesAt = 0;
let cachedRules: PolicyDocument["rules"] | null = null;

function hasDiskRoutes(rules: PolicyDocument["rules"]): boolean {
  return Object.values(rules).some((rule) => Boolean(rule.diskId));
}

/** Enable automation; adopt folder signatures only when no disk routes exist yet. */
export async function ensureAutomaticPolicies(): Promise<void> {
  const policy = await loadPolicy();
  let nextRules = policy.rules;
  let presetId = policy.presetId;

  if (!hasDiskRoutes(policy.rules)) {
    const now = Date.now();
    if (!cachedRules || now - cachedRoutesAt > 120_000) {
      const catalog = await readCatalog();
      const discovered = rulesFromDiscovered(catalog?.disks ?? []);
      if (hasDiskRoutes(discovered)) {
        cachedRules = discovered;
        cachedRoutesAt = now;
        nextRules = discovered;
        presetId = "custom";
      }
    } else {
      nextRules = cachedRules;
      presetId = "custom";
    }
  }

  const next: PolicyDocument = {
    ...policy,
    presetId,
    rules: nextRules,
    automationEnabled: true,
    preview: policy.preview,
  };
  const changed =
    policy.automationEnabled !== true ||
    policy.presetId !== next.presetId ||
    JSON.stringify(policy.rules) !== JSON.stringify(next.rules);
  if (changed) await savePolicy(next);

  const dashboard = await getDashboard();
  await ensureBaseline(dashboard.torrents.map((torrent) => ({ hostId: torrent.hostId, hash: torrent.hash })));
}

/**
 * Place only torrents the user just added (or newly appeared after baseline).
 * Never relocates the ignored baseline set. Never deletes originals.
 */
export async function tickAutomaticPlacement(): Promise<{ moved: number; skipped: number }> {
  if (ticking) return { moved: 0, skipped: 0 };
  const now = Date.now();
  if (now - lastTick < 8_000) return { moved: 0, skipped: 0 };
  lastTick = now;
  ticking = true;
  try {
    await ensureAutomaticPolicies();
    const policy = await loadPolicy();
    if (!policy.automationEnabled) return { moved: 0, skipped: 0 };

    const dashboard = await getDashboard();
    const state = await ensureBaseline(dashboard.torrents.map((t) => ({ hostId: t.hostId, hash: t.hash })));

    const newcomers = dashboard.torrents.filter((torrent) =>
      isAutoEligible(state, torrent.hostId, torrent.hash, torrent.addedOn),
    );
    if (newcomers.length === 0) return { moved: 0, skipped: dashboard.torrents.length };

    await markManagedMany(newcomers.map((torrent) => ({ hostId: torrent.hostId, hash: torrent.hash })));

    const input = await loadDryRunInput(policy);
    input.torrents = input.torrents.filter((torrent) =>
      newcomers.some((item) => item.hostId === torrent.hostId && item.hash === torrent.hash),
    );
    if (input.torrents.length === 0) return { moved: 0, skipped: 0 };

    const dry = buildDryRun(input);
    let moved = 0;
    let skipped = 0;
    for (const row of dry.rows) {
      let relocated = false;
      for (const step of row.steps) {
        if (step.type === "setLocation") {
          if (!row.sameHost || !row.diskOnline || !step.location) {
            skipped += 1;
            continue;
          }
          try {
            await relocateTorrent(row.hostId, row.hash, step.location);
            moved += 1;
            relocated = true;
          } catch {
            skipped += 1;
          }
        }
        if (step.type === "queue-handbrake") {
          await enqueuePolicyJob({
            kind: "handbrake",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: step.outputPath,
            note: `Профиль «${step.presetName}». Исходник не удаляется.`,
          });
        }
        if (step.type === "queue-compact") {
          await enqueuePolicyJob({
            kind: "compact",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: step.outputPath,
            note: "Отдельная сжатая копия на NTFS. Исходник не удаляется.",
          });
        }
        if (step.type === "index" && step.profile !== "none") {
          await enqueuePolicyJob({
            kind: "index",
            torrentName: row.name,
            hostId: row.hostId,
            hash: row.hash,
            sourcePath: row.destinationPath,
            outputPath: row.destinationPath,
            note: step.profile === "ntfs-mft" ? "Индекс NTFS MFT" : "Обычный обход каталога",
          });
        }
      }
      if (!relocated && !row.steps.some((step) => step.type === "setLocation")) skipped += 1;
    }

    const fingerprint = dryRunFingerprint(input);
    if (!policy.preview || policy.preview.fingerprint !== fingerprint) {
      await savePolicy({ ...policy, preview: { fingerprint, at: Date.now() }, automationEnabled: true });
    }
    return { moved, skipped };
  } finally {
    ticking = false;
  }
}

export async function inboxPathForHost(hostId: string): Promise<string> {
  const dashboard = await getDashboard();
  const host = dashboard.hosts.find((item) => item.id === hostId);
  if (!host) return "";
  const preset = host.pathPresets[0]?.path;
  if (preset) return preset;
  return host.os === "win32" ? "C:\\Users\\Public\\Downloads" : "/Volumes/vault/Downloads";
}

export async function safeTickAutomaticPlacement(): Promise<void> {
  try {
    await tickAutomaticPlacement();
  } catch (error) {
    console.error("Авторазмещение Склада:", error instanceof Error ? error.message : error);
  }
}
