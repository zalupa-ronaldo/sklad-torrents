import { createHash } from "node:crypto";

import { classify } from "@/lib/content/classify";
import type { ContentKind } from "@/lib/content/types";
import { CONTENT_KINDS } from "@/lib/content/types";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { planDownloads } from "@/lib/scheduler/plan";
import type { SchedulerPlan, SchedulerTorrent } from "@/lib/scheduler/types";
import type { DryRunInput, DryRunResult, DryRunRow, DryRunStep, HandbrakeSettings, PolicyDocument, QueueRole } from "@/lib/policies/types";
import {
  compactLeaf,
  constrainToFilesystem,
  handbrakeLeaf,
  outputPath,
  resolveDestination,
  sameDirectory,
} from "@/lib/policies/resolve";

const DOWNLOAD_NOW = new Set(["downloading", "metadata", "stalled", "checking"]);

export function buildDryRun(input: DryRunInput): DryRunResult {
  const prepared = input.torrents.map((torrent) => {
    const override = input.overrides.find((item) => item.hostId === torrent.hostId && item.hash === torrent.hash) ?? null;
    const classification = classify({
      name: torrent.name,
      savePath: torrent.savePath,
      files: torrent.files,
      override: override ? { kind: override.kind, gameSubtype: override.gameSubtype } : null,
    });
    const rule = input.rules[classification.kind];
    const dest = resolveDestination(rule, input.disks, input.hosts);
    const limits = constrainToFilesystem(rule, dest.filesystem);
    return { torrent, classification, rule, dest, limits };
  });

  const routed: SchedulerTorrent[] = prepared
    .filter(({ torrent }) => wantsDownload(torrent.progress, torrent.state))
    .map(({ torrent, dest }) => ({
      hostId: dest.hostId || torrent.hostId,
      hostName: dest.hostName || torrent.hostName,
      hostOs: dest.os,
      hash: torrent.hash,
      name: torrent.name,
      savePath: dest.path || torrent.savePath,
      state: DOWNLOAD_NOW.has(torrent.state) ? "downloading" : torrent.state === "paused" ? "paused" : "queued",
      rawState: DOWNLOAD_NOW.has(torrent.state) ? "downloading" : torrent.state === "paused" ? "pausedDL" : "queuedDL",
      progress: Math.min(torrent.progress, 0.99),
      userPaused: false,
    }));
  const schedulerPlan = planDownloads({
    torrents: routed,
    catalog: input.disks,
    order: {},
    priority: {},
  });

  const rows: DryRunRow[] = prepared.map(({ torrent, classification, rule, dest, limits }) => {
    const scheduler = schedulerRole(torrent.hash, schedulerPlan, wantsDownload(torrent.progress, torrent.state));
    const sameHost = Boolean(dest.hostId) && dest.hostId === torrent.hostId;
    const steps = buildSteps({
      complete: torrent.progress >= 0.999 && torrent.state !== "moving",
      savePath: torrent.savePath,
      sameHost,
      destOnline: dest.online,
      destPath: dest.path,
      destLabel: dest.label,
      destOs: dest.os,
      indexProfile: limits.indexProfile,
      postAction: limits.postAction,
      handbrake: rule.handbrake,
      torrentName: torrent.name,
      scheduler,
      wantsDownload: wantsDownload(torrent.progress, torrent.state),
    });
    return {
      hostId: torrent.hostId,
      hostName: torrent.hostName,
      hash: torrent.hash,
      name: torrent.name,
      kind: classification.kind,
      gameSubtype: classification.gameSubtype,
      reason: classification.reason,
      detail: classification.detail,
      diskId: dest.diskId,
      diskLabel: dest.label,
      diskOnline: dest.online,
      filesystem: dest.filesystem,
      folder: dest.folder,
      destinationPath: dest.path,
      sameHost,
      indexProfile: limits.indexProfile,
      indexRequested: rule.indexProfile,
      indexNote: limits.indexNote,
      postAction: limits.postAction,
      postActionRequested: rule.postAction,
      postUnavailable: limits.postUnavailable,
      postNote: limits.postNote,
      scheduler,
      deletesSource: false,
      steps,
    };
  });

  return { rows, deletesSource: false };
}

export function dryRunFingerprint(input: DryRunInput): string {
  const payload = {
    rules: input.rules,
    disks: [...input.disks]
      .map((disk) => ({
        serial: disk.serial,
        uuid: disk.uuid,
        online: disk.online,
        mounts: disk.mounts.map((mount) => ({ hostId: mount.hostId ?? "", os: mount.os, path: mount.path })),
      }))
      .sort((a, b) => a.serial.localeCompare(b.serial) || a.uuid.localeCompare(b.uuid)),
    overrides: [...input.overrides]
      .map((item) => ({
        hostId: item.hostId,
        hash: item.hash,
        kind: item.kind,
        gameSubtype: item.gameSubtype,
      }))
      .sort((a, b) => a.hostId.localeCompare(b.hostId) || a.hash.localeCompare(b.hash)),
    torrents: [...input.torrents]
      .map((torrent) => ({
        hostId: torrent.hostId,
        hash: torrent.hash,
        name: torrent.name,
        savePath: torrent.savePath,
        state: torrent.state,
        progress: Math.round(torrent.progress * 1000) / 1000,
        addedOn: torrent.addedOn,
        files: [...torrent.files]
          .map((file) => ({ name: file.name, size: file.size }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.hostId.localeCompare(b.hostId) || a.hash.localeCompare(b.hash)),
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function enableAutomation(policy: PolicyDocument, claimedFingerprint: string, currentFingerprint: string): PolicyDocument {
  const fresh =
    Boolean(claimedFingerprint) &&
    policy.preview?.fingerprint === claimedFingerprint &&
    claimedFingerprint === currentFingerprint;
  if (!fresh) {
    throw new QbittorrentError(
      "validation",
      "Автоматику нельзя включить без свежего сухого прогона. После смены правил старый прогон не годится.",
    );
  }
  return { ...policy, automationEnabled: true };
}

export function replaceRules(policy: PolicyDocument, rules: PolicyDocument["rules"], presetId: PolicyDocument["presetId"]): PolicyDocument {
  const changed = stableStringify(policy.rules) !== stableStringify(rules) || policy.presetId !== presetId;
  if (!changed) return policy;
  return {
    ...policy,
    presetId,
    rules,
    preview: null,
    automationEnabled: false,
  };
}

export function wantsDownload(progress: number, state: string): boolean {
  if (progress >= 0.999) return false;
  if (state === "seeding" || state === "moving" || state === "error" || state === "missing") return false;
  return true;
}

function buildSteps(input: {
  complete: boolean;
  savePath: string;
  sameHost: boolean;
  destOnline: boolean;
  destPath: string;
  destLabel: string;
  destOs: "darwin" | "win32";
  indexProfile: DryRunRow["indexProfile"];
  postAction: DryRunRow["postAction"];
  handbrake: HandbrakeSettings;
  torrentName: string;
  scheduler: DryRunRow["scheduler"];
  wantsDownload: boolean;
}): DryRunStep[] {
  if (!input.destOnline || !input.destPath) {
    return [{ type: "wait-offline", diskLabel: input.destLabel }];
  }
  if (input.wantsDownload && input.scheduler === "waiting-offline") {
    return [{ type: "wait-offline", diskLabel: input.destLabel }];
  }

  const steps: DryRunStep[] = [];
  if (input.wantsDownload && (input.scheduler === "active" || input.scheduler === "queued")) {
    steps.push({ type: "schedule", role: input.scheduler });
  }

  const alreadyThere = sameDirectory(input.destOs, input.savePath, input.destPath);
  const mayMove = input.complete || (input.wantsDownload && input.scheduler === "active");
  if (mayMove && !alreadyThere) {
    if (!input.sameHost) {
      steps.push({
        type: "hold-cross-host",
        note: "Диск на другом компьютере. Перенос только через setLocation внутри одного хоста, файлы в обход qBittorrent не двигаются.",
      });
    } else {
      steps.push({
        type: "setLocation",
        via: "qbittorrent.setLocation",
        location: input.destPath,
        deletesFiles: false,
      });
    }
  }

  if (!input.complete) return steps;

  if (input.indexProfile !== "none") {
    steps.push({ type: "index", profile: input.indexProfile });
  }
  if (input.postAction === "handbrake") {
    steps.push({
      type: "queue-handbrake",
      outputPath: outputPath(input.destOs, input.destPath, handbrakeLeaf(input.torrentName, input.handbrake)),
      presetName: input.handbrake.presetName,
      deletesSource: false,
    });
  }
  if (input.postAction === "compact") {
    steps.push({
      type: "queue-compact",
      outputPath: outputPath(input.destOs, input.destPath, compactLeaf(input.torrentName)),
      deletesSource: false,
    });
  }
  return steps;
}

function schedulerRole(hash: string, plan: SchedulerPlan, wants: boolean): QueueRole {
  if (!wants) return "idle";
  for (const queue of plan.queues) {
    if (queue.active?.hash === hash) return "active";
    const listed = queue.waiting.some((item) => item.hash === hash) || queue.manual.some((item) => item.hash === hash);
    if (listed) return queue.online ? "queued" : "waiting-offline";
  }
  return "idle";
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    const sorted: Record<string, unknown> = {};
    for (const [key, item] of entries) sorted[key] = sortValue(item);
    return sorted;
  }
  return value;
}

export function rulesCoverKinds(rules: PolicyDocument["rules"]): rules is PolicyDocument["rules"] {
  return CONTENT_KINDS.every((kind: ContentKind) => Boolean(rules[kind]));
}
