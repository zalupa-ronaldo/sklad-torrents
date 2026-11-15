import { Readable } from "node:stream";

import { AppError } from "@/lib/app-error";

export interface RemoteSource {
  agentUrl: string;
  serial: string;
  volumeUuid: string;
  relativePath: string;
}

function endpoint(remote: RemoteSource, pathname: string): URL {
  const url = new URL(`${remote.agentUrl.replace(/\/$/, "")}${pathname}`);
  url.searchParams.set("serial", remote.serial);
  url.searchParams.set("uuid", remote.volumeUuid);
  url.searchParams.set("path", remote.relativePath);
  return url;
}

export async function statAgentFile(remote: RemoteSource, signal?: AbortSignal): Promise<number> {
  const response = await fetch(endpoint(remote, "/v1/file/stat"), { cache: "no-store", signal });
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(502, agentMessage(text) || `Агент ответил ${response.status}. Отправка не создана.`);
  }
  let parsed: { size?: number };
  try {
    parsed = JSON.parse(text) as { size?: number };
  } catch {
    throw new AppError(502, "Агент вернул не размер файла.");
  }
  if (typeof parsed.size !== "number" || parsed.size < 0) {
    throw new AppError(502, "Агент не сообщил размер файла.");
  }
  return parsed.size;
}

/** Stream bytes from the Mac or PC agent. The caller hashes and forwards them; nothing is deleted. */
export async function openAgentFile(remote: RemoteSource, signal?: AbortSignal): Promise<Readable> {
  const response = await fetch(endpoint(remote, "/v1/file/content"), { cache: "no-store", signal });
  if (!response.ok || !response.body) {
    const text = response.ok ? "" : await response.text().catch(() => "");
    throw new AppError(502, agentMessage(text) || `Агент не отдал файл (${response.status}).`);
  }
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

function agentMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
    return parsed.error || parsed.message || trimmed.slice(0, 180);
  } catch {
    return trimmed.slice(0, 180);
  }
}
