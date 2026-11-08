import { planVolumeCompact, type CompactPlan } from "@/addons/drives/compact-target";
import { readAgentConfig, readCatalog } from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

export interface CompactJobView {
  id: string;
  state: "running" | "completed" | "failed";
  message: string;
  error: string | null;
  path: string;
  algorithm: string;
}

interface TrackedCompact {
  agentUrl: string;
  remoteId: string;
  path: string;
  algorithm: string;
}

const tracked = new Map<string, TrackedCompact>();

function diskHost(disk: DiskRecord): "darwin" | "win32" | null {
  const connected = disk.connectedHosts.find((host) => host.os === "win32") ?? disk.connectedHosts[0];
  if (connected) return connected.os;
  if (disk.pathStyle === "win32") return "win32";
  if (disk.pathStyle === "posix") return "darwin";
  return null;
}

export async function startVolumeCompact(input: {
  diskId: string;
  relativePath: string;
  algorithm: string;
  confirm: boolean;
}, fetchImpl: typeof fetch = fetch): Promise<CompactJobView> {
  const config = await readAgentConfig();
  const stored = await readCatalog();
  const disk = stored?.disks.find((item) => item.id === input.diskId);
  if (!disk) throw new DriveError(404, "Диск в каталоге не найден. Сжатие не запускалось.");
  if (disk.snapshotOnly) throw new DriveError(403, "Это офлайн-снимок. Сжатие не запускается.");
  const host = disk.connectedHosts.find((item) => item.os === "win32");
  const agent = config.agents.find((item) => item.os === "win32" && (item.id === host?.id || item.id === disk.lastHostId));
  const mount = (host?.mountPaths[0] || disk.lastMountPath || "").trim();
  const decision = planVolumeCompact({
    confirm: input.confirm,
    algorithm: input.algorithm,
    os: diskHost(disk) ?? "linux",
    filesystem: disk.filesystem,
    online: disk.connectedHosts.length > 0,
    mount,
    relativePath: input.relativePath,
    mode: config.mode,
    agentUrl: agent?.url ?? null,
  });
  if (!decision.ok) throw new DriveError(decision.status, decision.message);
  return dispatchCompact(decision, disk, input.relativePath, fetchImpl);
}

async function dispatchCompact(plan: CompactPlan, disk: DiskRecord, relativePath: string, fetchImpl: typeof fetch): Promise<CompactJobView> {
  let response: Response;
  try {
    response = await fetchImpl(`${plan.agentUrl.replace(/\/$/, "")}/v1/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serial: disk.serial,
        uuid: disk.volumeUuid,
        path: relativePath,
        algorithm: plan.algorithm,
        confirm: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new DriveError(502, "Агент Windows не ответил. Сжатие не запускалось.");
  }
  const body = (await response.json().catch(() => null)) as { id?: string; error?: string; state?: string; message?: string } | null;
  if (!response.ok || !body?.id) {
    throw new DriveError(response.status || 502, body?.error || "Агент Windows не принял сжатие. Оно не запускалось.");
  }
  const view: CompactJobView = {
    id: body.id,
    state: body.state === "failed" ? "failed" : "running",
    message: body.message || "Сжатие запущено на Windows. Размеры обновятся после перечитывания MFT.",
    error: body.state === "failed" ? body.error || body.message || "Сжатие не выполнилось." : null,
    path: plan.absolute,
    algorithm: plan.algorithm,
  };
  tracked.set(view.id, { agentUrl: plan.agentUrl, remoteId: body.id, path: plan.absolute, algorithm: plan.algorithm });
  return view;
}

export async function readVolumeCompact(id: string, fetchImpl: typeof fetch = fetch): Promise<CompactJobView> {
  const job = tracked.get(id);
  if (!job) throw new DriveError(404, "Задание сжатия не найдено.");
  let response: Response;
  try {
    response = await fetchImpl(`${job.agentUrl.replace(/\/$/, "")}/v1/compact?id=${encodeURIComponent(job.remoteId)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new DriveError(502, "Агент Windows не ответил о статусе сжатия.");
  }
  const body = (await response.json().catch(() => null)) as { state?: string; error?: string; message?: string } | null;
  if (!response.ok || !body) throw new DriveError(response.status || 502, "Не удалось прочитать статус сжатия.");
  const state = body.state === "completed" || body.state === "failed" ? body.state : "running";
  return {
    id,
    state,
    message: body.message || (state === "completed" ? "Сжатие завершилось. Размеры обновятся после перечитывания диска." : "Сжатие выполняется."),
    error: state === "failed" ? body.error || body.message || "Сжатие не выполнилось." : null,
    path: job.path,
    algorithm: job.algorithm,
  };
}
