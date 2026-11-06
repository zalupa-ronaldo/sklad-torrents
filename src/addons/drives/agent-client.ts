import type { AgentEndpoint, HostObservation, IndexPayload, RawIndexedFile } from "@/addons/drives/types";
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

export async function pollAgent(agent: AgentEndpoint): Promise<HostObservation> {
  const base = assertHttpUrl(agent.url);
  const response = await fetch(`${base}/v1/volumes`, {
    cache: "no-store",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new DriveError(502, `${agent.name}: агент ответил ${response.status}.`);
  }
  const body = (await response.json()) as VolumeResponse;
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

export async function pollAgents(agents: readonly AgentEndpoint[]): Promise<{
  observations: HostObservation[];
  errors: { hostName: string; message: string }[];
}> {
  const observations: HostObservation[] = [];
  const errors: { hostName: string; message: string }[] = [];
  await Promise.all(
    agents.map(async (agent) => {
      try {
        observations.push(await pollAgent(agent));
      } catch (error) {
        errors.push({
          hostName: agent.name,
          message: error instanceof Error ? error.message : "Агент недоступен.",
        });
      }
    }),
  );
  return { observations, errors };
}
