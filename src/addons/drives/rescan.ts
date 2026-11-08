import { readAgentConfig, readCatalog } from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

function agentFor(disk: DiskRecord, agents: { id: string; os: "darwin" | "win32"; url: string }[]) {
  const host = disk.connectedHosts[0];
  return agents.find((agent) => agent.id === host?.id)
    ?? agents.find((agent) => agent.id === disk.lastHostId)
    ?? agents.find((agent) => agent.os === (disk.pathStyle === "win32" ? "win32" : "darwin"));
}

/** Ask the drive-agent that owns the disk to index it. Does not walk the disk in this process. */
export async function requestDiskRescan(diskId: string, fetchImpl: typeof fetch = fetch): Promise<{ accepted: true; message: string }> {
  const stored = await readCatalog();
  const disk = stored?.disks.find((item) => item.id === diskId);
  if (disk?.snapshotOnly) throw new DriveError(403, "Это офлайн-снимок. Сканирование не запускается.");
  const config = await readAgentConfig();
  if (config.mode === "mock") {
    throw new DriveError(400, "Это демонстрационный каталог. Сканирование носителя не запускалось.");
  }
  if (!disk) throw new DriveError(404, "Диск в каталоге не найден. Сканирование не запускалось.");
  if (disk.connectedHosts.length === 0) throw new DriveError(409, "Диск не подключён. Сканирование не запускалось.");
  const agent = agentFor(disk, config.agents);
  if (!agent) throw new DriveError(503, "Нет адреса drive-agent для этого диска. Сканирование не запускалось.");
  let url: URL;
  try {
    url = new URL(agent.url);
  } catch {
    throw new DriveError(400, "Адрес агента некорректный. Сканирование не запускалось.");
  }
  if (url.port === "4730") {
    throw new DriveError(503, "Порт 4730 — job-агент, он не индексирует диски. Нужен drive-agent (4371 на Mac, 4372 на Windows).");
  }
  const target = new URL(`${agent.url.replace(/\/$/, "")}/v1/rescan`);
  target.searchParams.set("serial", disk.serial);
  target.searchParams.set("uuid", disk.volumeUuid);
  let response: Response;
  try {
    response = await fetchImpl(target, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    throw new DriveError(502, "Агент не ответил. Сканирование не запускалось.");
  }
  const body = (await response.json().catch(() => null)) as { accepted?: boolean; error?: string } | null;
  if (!response.ok || !body?.accepted) {
    throw new DriveError(response.status || 502, body?.error || "Агент не принял сканирование.");
  }
  return { accepted: true, message: "Сканирование поставлено агенту. Каталог обновится, когда индекс будет готов." };
}
