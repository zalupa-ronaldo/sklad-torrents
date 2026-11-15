import { readCatalog } from "@/addons/drives/store";
import { rulesFromDiscovered } from "@/lib/policies/auto-routes";
import { ensureBaseline } from "@/lib/policies/auto-managed";
import { loadPolicy, savePolicy } from "@/lib/policies/store";
import type { PolicyDocument } from "@/lib/policies/types";
import { getDashboard } from "@/lib/qbittorrent/service";
import { scheduleAutoPipeline } from "@/lib/scheduler/auto-watch";

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
 * Queue the auto pipeline on a later turn. The HTTP handler does not wait
 * for index, copy, compress, or hash. Originals are never deleted.
 */
export async function tickAutomaticPlacement(): Promise<{ moved: number; skipped: number }> {
  scheduleAutoPipeline();
  return { moved: 0, skipped: 0 };
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
