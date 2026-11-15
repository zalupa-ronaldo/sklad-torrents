export const CHANNEL_LISTEN_PORT = 18080;
export const CHANNEL_WSL_PORT = 8080;
export const CHANNEL_STALE_MS = 30_000;

export const CHANNEL_TEXT = {
  wslIpChanged: "Адрес WSL сменился. Канал восстанавливается.",
  socatDown: "Канал socat не запущен.",
  portproxyMissing: "Проброс порта не поднят.",
  qbittorrentDown: "qBittorrent не отвечает.",
  handbrakeDown: "HandBrake на этой машине не отвечает.",
  agentMissing: "Агент Windows не заявлен.",
} as const;

export type ServiceState = "up" | "down";
export type ChannelState = "up" | "recovering" | "down";
export type RecoverCause = "wsl" | "socat" | "portproxy" | "qb";

export interface PeerLink {
  qbittorrent: ServiceState;
  handbrake: ServiceState;
  detail: string | null;
}

export interface ChannelLinkView {
  state: ChannelState;
  peers: {
    "mac-local": PeerLink;
    "pc-agent": PeerLink;
  };
}

export interface RepairAction {
  op: "start-socat" | "restart-socat" | "ensure-portproxy";
  listenHost: string;
  listenPort: number;
  connectHost?: string;
  connectPort?: number;
  wslIp?: string;
  wslPort?: number;
}

export interface HeartbeatInput {
  worker: "pc-agent";
  wslIp: string | null;
  socatOk: boolean;
  portproxyOk: boolean;
  qbittorrentOk: boolean;
  handbrakeOk: boolean;
  macQbittorrentOk?: boolean;
  macHandbrakeOk?: boolean;
  stableBaseUrl?: string;
}

export interface ChannelFile {
  version: 1;
  listenPort: number;
  wslPort: number;
  stableBaseUrl: string | null;
  qbHostId: string | null;
  lastWslIp: string | null;
  currentWslIp: string | null;
  agentLastSeenMs: number | null;
  socatOk: boolean;
  portproxyOk: boolean;
  pcQbittorrentOk: boolean;
  pcHandbrakeOk: boolean;
  macQbittorrentOk: boolean;
  macHandbrakeOk: boolean;
  recoverCause: RecoverCause | null;
  repairing: boolean;
  qbRepairAttempted: boolean;
  baseUrlPinned: boolean;
  updatedAt: string;
}

export function emptyChannel(now: number, qbHostId: string | null = null): ChannelFile {
  return {
    version: 1,
    listenPort: CHANNEL_LISTEN_PORT,
    wslPort: CHANNEL_WSL_PORT,
    stableBaseUrl: null,
    qbHostId,
    lastWslIp: null,
    currentWslIp: null,
    agentLastSeenMs: null,
    socatOk: false,
    portproxyOk: false,
    pcQbittorrentOk: false,
    pcHandbrakeOk: false,
    macQbittorrentOk: true,
    macHandbrakeOk: true,
    recoverCause: null,
    repairing: false,
    qbRepairAttempted: false,
    baseUrlPinned: false,
    updatedAt: new Date(now).toISOString(),
  };
}

export function reconcile(file: ChannelFile, input: HeartbeatInput, now: number): { file: ChannelFile; actions: RepairAction[] } {
  const ipChanged = Boolean(input.wslIp && file.lastWslIp && input.wslIp !== file.lastWslIp);
  const bridgeBack = input.socatOk && input.portproxyOk && input.qbittorrentOk;
  const continuingWsl = file.recoverCause === "wsl" && !ipChanged && !bridgeBack;
  const next: ChannelFile = {
    ...file,
    currentWslIp: input.wslIp,
    lastWslIp: input.wslIp ?? file.lastWslIp,
    agentLastSeenMs: now,
    socatOk: input.socatOk,
    portproxyOk: input.portproxyOk,
    pcQbittorrentOk: input.qbittorrentOk,
    pcHandbrakeOk: input.handbrakeOk,
    macQbittorrentOk: typeof input.macQbittorrentOk === "boolean" ? input.macQbittorrentOk : file.macQbittorrentOk,
    macHandbrakeOk: typeof input.macHandbrakeOk === "boolean" ? input.macHandbrakeOk : file.macHandbrakeOk,
    stableBaseUrl: input.stableBaseUrl ?? file.stableBaseUrl,
    updatedAt: new Date(now).toISOString(),
    qbRepairAttempted: ipChanged ? false : file.qbRepairAttempted,
  };
  const actions: RepairAction[] = [];
  if (ipChanged || continuingWsl) {
    next.recoverCause = "wsl";
    next.repairing = true;
    if (input.wslIp && (ipChanged || !input.socatOk)) actions.push(socatAction(ipChanged ? "restart-socat" : "start-socat", input.wslIp, next));
    if (!input.portproxyOk) actions.push(portproxyAction(next));
  } else if (!input.socatOk) {
    next.recoverCause = "socat";
    next.repairing = true;
    if (input.wslIp) actions.push(socatAction("start-socat", input.wslIp, next));
    if (!input.portproxyOk) actions.push(portproxyAction(next));
  } else if (!input.portproxyOk) {
    next.recoverCause = "portproxy";
    next.repairing = true;
    actions.push(portproxyAction(next));
  } else if (!input.qbittorrentOk) {
    next.recoverCause = "qb";
    if (!next.qbRepairAttempted && input.wslIp) {
      next.repairing = true;
      next.qbRepairAttempted = true;
      actions.push(socatAction("restart-socat", input.wslIp, next));
    } else {
      next.repairing = false;
      next.qbRepairAttempted = true;
    }
  } else {
    next.recoverCause = null;
    next.repairing = false;
    next.qbRepairAttempted = false;
  }
  return { file: next, actions };
}

export function project(file: ChannelFile, now: number): ChannelLinkView {
  const fresh = file.agentLastSeenMs !== null && now - file.agentLastSeenMs <= CHANNEL_STALE_MS;
  const pc = fresh ? peerPc(file) : { qbittorrent: "down" as const, handbrake: "down" as const, detail: CHANNEL_TEXT.agentMissing };
  const mac = peerMac(file);
  const allUp = pc.qbittorrent === "up" && pc.handbrake === "up" && mac.qbittorrent === "up" && mac.handbrake === "up";
  const state: ChannelState = allUp ? "up" : fresh && file.repairing ? "recovering" : "down";
  return { state, peers: { "mac-local": mac, "pc-agent": pc } };
}

export function channelErrorForProbe(
  file: ChannelFile | null,
  input: { id?: string; baseUrl?: string },
  now: number,
): string | null {
  if (!file) return null;
  const link = project(file, now);
  const target = probeTarget(input, file);
  if (target === "pc") {
    const peer = link.peers["pc-agent"];
    if (peer.qbittorrent === "down" && peer.detail && peer.detail !== CHANNEL_TEXT.handbrakeDown) return peer.detail;
    return null;
  }
  if (target === "mac" && link.peers["mac-local"].qbittorrent === "down") return CHANNEL_TEXT.qbittorrentDown;
  return null;
}

export function overlayHostError<T extends { os: string; online: boolean; error: string | null }>(host: T, link: ChannelLinkView): T {
  if (host.online) return host;
  if (host.os === "win32") {
    const peer = link.peers["pc-agent"];
    if (peer.qbittorrent === "down" && peer.detail) return { ...host, error: peer.detail };
  }
  if (host.os === "darwin") {
    const peer = link.peers["mac-local"];
    if (peer.qbittorrent === "down" && peer.detail) return { ...host, error: peer.detail };
  }
  return host;
}

function peerPc(file: ChannelFile): PeerLink {
  const bridge = file.socatOk && file.portproxyOk && file.recoverCause !== "wsl";
  const qbittorrent: ServiceState = bridge && file.pcQbittorrentOk ? "up" : "down";
  const handbrake: ServiceState = file.pcHandbrakeOk ? "up" : "down";
  return { qbittorrent, handbrake, detail: detailPc(file, qbittorrent, handbrake) };
}

function detailPc(file: ChannelFile, qbittorrent: ServiceState, handbrake: ServiceState): string | null {
  if (file.recoverCause === "wsl") return CHANNEL_TEXT.wslIpChanged;
  if (!file.socatOk) return CHANNEL_TEXT.socatDown;
  if (!file.portproxyOk) return CHANNEL_TEXT.portproxyMissing;
  if (qbittorrent === "down") return CHANNEL_TEXT.qbittorrentDown;
  if (handbrake === "down") return CHANNEL_TEXT.handbrakeDown;
  return null;
}

function peerMac(file: ChannelFile): PeerLink {
  const qbittorrent: ServiceState = file.macQbittorrentOk ? "up" : "down";
  const handbrake: ServiceState = file.macHandbrakeOk ? "up" : "down";
  const detail = qbittorrent === "down" ? CHANNEL_TEXT.qbittorrentDown : handbrake === "down" ? CHANNEL_TEXT.handbrakeDown : null;
  return { qbittorrent, handbrake, detail };
}

function socatAction(op: "start-socat" | "restart-socat", wslIp: string, file: ChannelFile): RepairAction {
  return {
    op,
    listenHost: "127.0.0.1",
    listenPort: file.listenPort,
    wslIp,
    wslPort: file.wslPort,
  };
}

function portproxyAction(file: ChannelFile): RepairAction {
  return {
    op: "ensure-portproxy",
    listenHost: "0.0.0.0",
    listenPort: file.listenPort,
    connectHost: "127.0.0.1",
    connectPort: file.listenPort,
  };
}

function probeTarget(input: { id?: string; baseUrl?: string }, file: ChannelFile): "pc" | "mac" | null {
  if (input.id && file.qbHostId && input.id === file.qbHostId) return "pc";
  const raw = input.baseUrl?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (file.stableBaseUrl) {
    try {
      if (url.origin === new URL(file.stableBaseUrl).origin) return "pc";
    } catch {
      return null;
    }
  }
  if ((file.currentWslIp && url.hostname === file.currentWslIp) || (file.lastWslIp && url.hostname === file.lastWslIp)) return "pc";
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port === file.listenPort && !isLoopback(url.hostname)) return "pc";
  if (isLoopback(url.hostname)) return "mac";
  return null;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
