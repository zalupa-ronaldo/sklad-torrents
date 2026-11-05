import { randomUUID } from "node:crypto";

import { OpticalError } from "@/lib/optical/errors";
import { assertNoLocalMacBurn, buildHardwarePlan, buildOfflineImagePlan } from "@/lib/optical/protocol";
import type { MacJobRequest, OfflineProfile, OpticalJob, OpticalKind } from "@/lib/optical/types";
import { WINDOWS_AGENT_HOST } from "@/lib/optical/types";

const HARDWARE_NEEDS_DRIVE = new Set<OpticalKind>(["burn", "verify", "discimagestudio-live", "media-info"]);

function now(): string {
  return new Date().toISOString();
}

function defaultOfflineOutput(sourcePath: string, profile: OfflineProfile): string {
  const base = sourcePath.split(/[/\\]/).pop() || "image";
  const ext = profile === "cd" ? "wav" : "iso";
  return `offline-images/${base}.${ext}`;
}

function shell(partial: Omit<OpticalJob, "physicalDiscBurned"> & { physicalDiscBurned?: false }): OpticalJob {
  return { ...partial, physicalDiscBurned: false };
}

/**
 * Build a queue job on the Mac. Hardware work is always addressed to `pc-agent`.
 * The argv is a plan for that agent. It is not executed on the Mac.
 */
export function buildMacOpticalJob(request: MacJobRequest): OpticalJob {
  if (request.kind === "discimagestudio-offline") return buildOffline(request);
  if (request.host && request.host !== "pc-agent" && request.host !== "windows") {
    throw new OpticalError("forbidden", "Mac не записывает диск локально. Задание уходит только агенту Windows.");
  }
  const sourcePath = (request.sourcePath ?? "").trim();
  const driveId = request.driveId?.trim() || null;
  if ((request.kind === "burn" || request.kind === "discimagestudio-live") && !sourcePath) {
    throw new OpticalError("validation", "Укажите путь к файлу на Windows-ПК.");
  }
  if (HARDWARE_NEEDS_DRIVE.has(request.kind) && !driveId) {
    throw new OpticalError("validation", "Выберите привод, который сообщил агент Windows.");
  }
  const eraseConfirmed = Boolean(request.eraseConfirmed);
  const built = buildHardwarePlan({
    kind: request.kind,
    sourcePath,
    driveId,
    eraseConfirmed,
  });
  assertNoLocalMacBurn(built.argv, built.plan);
  const stamp = now();
  return shell({
    id: `opt_${randomUUID()}`,
    kind: request.kind,
    host: WINDOWS_AGENT_HOST,
    status: "queued",
    sourcePath,
    outputPath: null,
    driveId,
    driveName: null,
    mediaType: null,
    capacityBytes: null,
    eraseConfirmed,
    argv: built.argv,
    plan: built.plan,
    progress: 0,
    exitCode: null,
    burnExited: false,
    verified: false,
    verifiedBy: null,
    simulation: false,
    error: null,
    log: ["Mac: задание поставлено в очередь для агента Windows."],
    drives: null,
    createdAt: stamp,
    updatedAt: stamp,
    claimedBy: null,
  });
}

function buildOffline(request: MacJobRequest): OpticalJob {
  const sourcePath = (request.sourcePath ?? "").trim();
  if (!sourcePath) throw new OpticalError("validation", "Укажите файл для офлайн-образа.");
  const profile = request.profile ?? "dvd";
  const outputPath = (request.outputPath ?? "").trim() || defaultOfflineOutput(sourcePath, profile);
  const offlineHost = request.offlineHost ?? "darwin";
  if (offlineHost !== "darwin" && offlineHost !== "linux" && offlineHost !== "pc-agent" && offlineHost !== "windows") {
    throw new OpticalError("validation", "Офлайн-образ можно запланировать на Mac, Linux или агенте Windows.");
  }
  const built = buildOfflineImagePlan({ sourcePath, outputPath, profile });
  assertNoLocalMacBurn(built.argv, built.plan);
  const stamp = now();
  return shell({
    id: `opt_${randomUUID()}`,
    kind: "discimagestudio-offline",
    host: offlineHost === "windows" ? WINDOWS_AGENT_HOST : offlineHost,
    status: "queued",
    sourcePath,
    outputPath,
    driveId: null,
    driveName: null,
    mediaType: null,
    capacityBytes: null,
    eraseConfirmed: false,
    argv: built.argv,
    plan: built.plan,
    progress: 0,
    exitCode: null,
    burnExited: false,
    verified: false,
    verifiedBy: null,
    simulation: false,
    error: null,
    log: ["Mac: экспериментальный офлайн-план CLI. Это не запись, привод не нужен."],
    drives: null,
    createdAt: stamp,
    updatedAt: stamp,
    claimedBy: null,
  });
}
