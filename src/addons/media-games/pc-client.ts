import { ToolsError } from "@/addons/media-games/errors";
import type { CompactAlgorithm, JobState, VerifyResult } from "@/addons/media-games/types";

export interface AgentJobPayload {
  id: string;
  state: JobState;
  progress: number;
  error: string | null;
  plannedArgv: string[];
  outputMarker: string | null;
  verified: boolean;
  deleteSource: boolean;
  sourceDeleted: boolean;
  verify: VerifyResult | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  spawned: boolean;
}

export interface AgentEnqueueBody {
  kind: "transcode" | "move" | "compress";
  title: string;
  handbrakePath?: string;
  inputPath?: string;
  outputPath?: string;
  preset?: string;
  compactPath?: string;
  folderPath?: string;
  algorithm?: CompactAlgorithm;
  sourcePath?: string;
  destinationPath?: string;
}

export async function agentEnqueue(baseUrl: string, body: AgentEnqueueBody): Promise<AgentJobPayload> {
  return agentRequest<AgentJobPayload>(baseUrl, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function agentTick(baseUrl: string, id: string): Promise<AgentJobPayload> {
  return agentRequest<AgentJobPayload>(baseUrl, `/v1/jobs/${encodeURIComponent(id)}/tick`, { method: "POST" });
}

export async function agentConfirm(baseUrl: string, id: string, deleteSource: boolean): Promise<AgentJobPayload> {
  return agentRequest<AgentJobPayload>(baseUrl, `/v1/jobs/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ deleteSource }),
  });
}

async function agentRequest<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    response = await fetch(url, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ToolsError(
      "unavailable",
      "Агент на Windows не ответил. Запустите agents/pc-agent и проверьте адрес в настройках. Прокси не используется.",
    );
  }
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ToolsError(response.status === 404 ? "not_found" : "validation", payload.error || "Агент отклонил задание.");
  }
  return payload as T;
}
