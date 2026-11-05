import { AGENT_OFFLINE, OpticalError } from "@/lib/optical/errors";
import type { OpticalDrive, OpticalJob } from "@/lib/optical/types";

interface AgentHealth {
  ok: boolean;
  host: string;
  mock: boolean;
  physicalDiscBurned: false;
}

export function normalizeAgentUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OpticalError("validation", "Адрес агента Windows должен быть http(s) URL в локальной сети.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpticalError("validation", "Агент Windows доступен по HTTP в локальной сети.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class HttpWindowsAgent {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeAgentUrl(baseUrl);
  }

  async health(): Promise<AgentHealth> {
    return this.request<AgentHealth>("/health");
  }

  async submit(job: OpticalJob): Promise<OpticalJob> {
    return this.request<OpticalJob>("/jobs", {
      method: "POST",
      body: JSON.stringify(job),
    });
  }

  async getJob(id: string): Promise<OpticalJob | null> {
    try {
      return await this.request<OpticalJob>(`/jobs/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof OpticalError && error.code === "not_found") return null;
      throw error;
    }
  }

  async listDrives(): Promise<OpticalDrive[]> {
    const body = await this.request<{ drives: OpticalDrive[] }>("/drives");
    return body.drives ?? [];
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        cache: "no-store",
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      throw new OpticalError("offline", AGENT_OFFLINE);
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 404) {
      throw new OpticalError("not_found", payload.error || "Задание на агенте Windows не найдено.");
    }
    if (response.status === 400) {
      throw new OpticalError("validation", payload.error || "Агент Windows отклонил задание.");
    }
    if (response.status === 403) {
      throw new OpticalError("forbidden", payload.error || "Агент Windows отклонил задание.");
    }
    if (!response.ok) throw new OpticalError("offline", AGENT_OFFLINE);
    return payload as T;
  }
}
