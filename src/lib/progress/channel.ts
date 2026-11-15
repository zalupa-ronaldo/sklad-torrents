/** Phrases the Mac↔PC channel shows in the panel. They are not a task failure. */
export const CHANNEL_DETAILS = [
  "Адрес WSL сменился. Канал восстанавливается.",
  "Канал socat не запущен.",
  "Проброс порта не поднят.",
  "qBittorrent не отвечает.",
  "HandBrake на этой машине не отвечает.",
  "Агент Windows не заявлен.",
] as const;

export function isChannelDetail(message: string | null | undefined): message is string {
  return typeof message === "string" && (CHANNEL_DETAILS as readonly string[]).includes(message);
}

export interface LinkPeer {
  qbittorrent: "up" | "down";
  handbrake: "up" | "down";
  detail: string | null;
}

export interface LinkStatus {
  state: "up" | "recovering" | "down";
  peers: {
    "mac-local": LinkPeer;
    "pc-agent": LinkPeer;
  };
}

export function parseLinkStatus(value: unknown): LinkStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { state?: unknown; peers?: unknown };
  if (raw.state !== "up" && raw.state !== "recovering" && raw.state !== "down") return null;
  if (!raw.peers || typeof raw.peers !== "object") return null;
  const peers = raw.peers as Record<string, unknown>;
  const mac = parsePeer(peers["mac-local"]);
  const pc = parsePeer(peers["pc-agent"]);
  if (!mac || !pc) return null;
  return { state: raw.state, peers: { "mac-local": mac, "pc-agent": pc } };
}

function parsePeer(value: unknown): LinkPeer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { qbittorrent?: unknown; handbrake?: unknown; detail?: unknown };
  if (raw.qbittorrent !== "up" && raw.qbittorrent !== "down") return null;
  if (raw.handbrake !== "up" && raw.handbrake !== "down") return null;
  const detail = typeof raw.detail === "string" && isChannelDetail(raw.detail) ? raw.detail : null;
  return { qbittorrent: raw.qbittorrent, handbrake: raw.handbrake, detail };
}
