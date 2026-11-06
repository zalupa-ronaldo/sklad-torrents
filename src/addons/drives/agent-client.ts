import { createHash } from "node:crypto";
import { normalizeSerial, normalizeUuid } from "@/addons/drives/identity";
import { indexFetchPlan } from "@/addons/drives/shelf-plan";
import type { AgentEndpoint, DiskRecord, HostObservation, IndexPayload, RawIndexedFile } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

interface WireVolume {
  serial?: string;
  volumeUuid?: string;
  filesystem?: string;
  volumeName?: string;
  mountPaths?: string[];
  totalBytes?: number;
  freeBytes?: number;
  busy?: boolean;
  index?: IndexPayload | null;
}

interface VolumeResponse {
  hostId?: string;
  hostName?: string;
  os?: "darwin" | "win32";
  elevated?: boolean;
  volumes?: WireVolume[];
}

function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DriveError(400, "Адрес агента должен быть http или https.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DriveError(400, "Адрес агента должен быть http или https.");
  }
  return url.toString().replace(/\/$/, "");
}

export interface DeferredSnapshot {
  agent: AgentEndpoint;
  serial: string;
  volumeUuid: string;
  revision: string;
  recordCount: number;
}

export async function pollAgent(agent: AgentEndpoint, known: readonly DiskRecord[] = [], deferred: DeferredSnapshot[] = []): Promise<HostObservation> {
  const base = assertHttpUrl(agent.url);
  const response = await fetch(`${base}/v1/volumes?metadata=1`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new DriveError(502, `${agent.name}: агент ответил ${response.status}.`);
  }
  const body = (await response.json()) as VolumeResponse;
  // Hydrate only a changed, complete revision. Commit it only after every page arrived.
  for (const volume of body.volumes ?? []) {
    const index = volume.index;
    const existing = known.find((disk) => normalizeSerial(disk.serial) === normalizeSerial(volume.serial ?? "") && normalizeUuid(disk.volumeUuid) === normalizeUuid(volume.volumeUuid ?? ""));
    // Compatibility with an already-running older Mac agent until its next restart.
    if (index?.files && !index.revision) index.revision = `legacy:${createHash("sha256").update(JSON.stringify(index.files)).digest("hex")}`;
    const plan = indexFetchPlan({
      state: index?.state,
      revision: index?.revision,
      recordCount: index?.recordCount ?? (index?.files ? index.files.length : 0),
      knownRevision: existing?.indexRevision,
      pendingRevision: existing?.pendingRevision,
    });
    if (plan === "none" || plan === "skip") {
      if (index) { delete index.files; delete index.delta; }
      continue;
    }
    const prior = existing;
    if (prior && !prior.indexRevision && index?.revision === `restored:${prior.files.length}` && index.recordCount === prior.files.length) continue;
    if (plan === "defer" && index?.revision) {
      index.deferred = true;
      delete index.files;
      delete index.delta;
      deferred.push({
        agent,
        serial: String(volume.serial ?? ""),
        volumeUuid: String(volume.volumeUuid ?? ""),
        revision: index.revision,
        recordCount: index.recordCount ?? 0,
      });
      continue;
    }
    if (!index?.revision) continue;
    const files: RawIndexedFile[] = [];
    const expected = index.recordCount ?? 0;
    while (files.length < expected) {
      const params = new URLSearchParams({ serial: String(volume.serial), uuid: String(volume.volumeUuid), revision: index.revision, offset: String(files.length), limit: "10000" });
      const pageResponse = await fetch(`${base}/v1/files?${params}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!pageResponse.ok) throw new DriveError(502, `${agent.name}: снимок изменился или страница недоступна.`);
      const page = await pageResponse.json() as { files: RawIndexedFile[]; revision: string };
      if (page.revision !== index.revision || !Array.isArray(page.files) || !page.files.length) throw new DriveError(502, "Неполная страница индекса.");
      files.push(...page.files.filter(isRawFile));
    }
    if (files.length !== expected) throw new DriveError(502, "Неполный снимок индекса.");
    index.files = files;
  }
  const os = body.os === "win32" || body.os === "darwin" ? body.os : agent.os;
  const volumes = Array.isArray(body.volumes) ? body.volumes : [];
  return {
    hostId: body.hostId || agent.id,
    hostName: body.hostName || agent.name,
    os,
    elevated: body.elevated === true,
    volumes: volumes.map((volume) => ({
      serial: String(volume.serial ?? ""),
      volumeUuid: String(volume.volumeUuid ?? ""),
      filesystem: String(volume.filesystem ?? ""),
      volumeName: String(volume.volumeName ?? ""),
      mountPaths: Array.isArray(volume.mountPaths) ? volume.mountPaths.map(String) : [],
      totalBytes: Number(volume.totalBytes) || 0,
      freeBytes: Number(volume.freeBytes) || 0,
      busy: volume.busy === true,
      index: sanitizeIndex(volume.index),
    })),
  };
}

function sanitizeIndex(index: IndexPayload | null | undefined): IndexPayload | null {
  if (!index || typeof index !== "object") return null;
  const state = index.state;
  if (state !== "idle" && state !== "running" && state !== "paused" && state !== "complete" && state !== "error") return null;
  const files = Array.isArray(index.files) ? index.files.filter(isRawFile) : undefined;
  return {
    state,
    revision: index.revision,
    recordCount: index.recordCount,
    progress: Number(index.progress) || 0,
    message: typeof index.message === "string" ? index.message.slice(0, 400) : undefined,
    strategy: index.strategy === "mft-usn" ? "mft-usn" : "walk",
    files,
    delta: index.delta && index.delta.complete === true ? index.delta : undefined,
  };
}

function isRawFile(value: unknown): value is RawIndexedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as RawIndexedFile;
  return typeof file.relativePath === "string" && typeof file.name === "string" && (file.kind === "file" || file.kind === "dir");
}

export async function pollAgents(agents: readonly AgentEndpoint[], known: readonly DiskRecord[] = []): Promise<{
  observations: HostObservation[];
  errors: { hostName: string; message: string }[];
  deferred: DeferredSnapshot[];
}> {
  const observations: HostObservation[] = [];
  const errors: { hostName: string; message: string }[] = [];
  const deferred: DeferredSnapshot[] = [];
  await Promise.all(
    agents.map(async (agent) => {
      try {
        observations.push(await pollAgent(agent, known, deferred));
      } catch (error) {
        errors.push({
          hostName: agent.name,
          message: error instanceof Error ? error.message : "Агент недоступен.",
        });
      }
    }),
  );
  return { observations, errors, deferred };
}
