import { spawn } from "node:child_process";

import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { clientFor, requireHost } from "@/lib/qbittorrent/service";
import { dataDir } from "@/lib/qbittorrent/store";
import {
  disableQbittorrentSupervisor,
  enableQbittorrentSupervisor,
  tickQbittorrentWatchdog,
} from "@/lib/qbittorrent/watchdog";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      hostId?: string;
      action?: string;
      distro?: string;
      user?: string;
      binary?: string;
    } | null;
    if (!body || typeof body !== "object") throw new QbittorrentError("validation", "Неизвестное действие.");
    const hostId = String(body.hostId || "");
    if (!hostId) throw new QbittorrentError("validation", "Не выбран хост.");
    const host = await requireHost(hostId);
    const dir = dataDir();
    if (body.action === "enable") {
      return json(
        await enableQbittorrentSupervisor(dir, host.id, {
          distro: body.distro,
          user: body.user,
          binary: body.binary,
        }),
      );
    }
    if (body.action === "disable") return json(await disableQbittorrentSupervisor(dir, host.id));
    if (body.action === "tick") {
      return json(
        await tickQbittorrentWatchdog(host.id, dir, {
          pathStyle: host.pathStyle,
          probe: async () => {
            try {
              await clientFor(host).probe();
              return true;
            } catch {
              return false;
            }
          },
          start: startDetached,
        }),
      );
    }
    throw new QbittorrentError("validation", "Неизвестное действие.");
  });
}

function startDetached(args: string[]): void {
  const command = args[0];
  if (!command) throw new Error("start");
  const child = spawn(command, args.slice(1), { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
