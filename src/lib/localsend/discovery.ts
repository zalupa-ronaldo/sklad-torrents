import dgram from "node:dgram";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { appDataDir } from "@/lib/app-data";
import { AppError } from "@/lib/app-error";
import { fetchPeerInfo, registerWithPeer, type PeerTarget } from "@/lib/localsend/client";
import {
  LOCALSEND_MULTICAST_ADDRESS,
  LOCALSEND_PORT,
  normalizeFingerprint,
  type DeviceInfo,
  type LocalProtocol,
} from "@/lib/localsend/protocol";

export interface DiscoveredDevice {
  alias: string;
  address: string;
  port: number;
  protocol: LocalProtocol;
  fingerprint: string;
  deviceModel: string | null;
  deviceType: string | null;
  version: string;
  demo: boolean;
  source: "multicast" | "manual" | "mock";
  lastSeen: number;
}

interface DiscoveryRuntime {
  devices: Map<string, DiscoveredDevice>;
  lastError: string | null;
  socket: dgram.Socket | null;
  timer: NodeJS.Timeout | null;
  self: (() => DeviceInfo) | null;
}

function runtime(): DiscoveryRuntime {
  const g = globalThis as { __skladDiscovery?: DiscoveryRuntime };
  if (!g.__skladDiscovery) {
    g.__skladDiscovery = { devices: new Map(), lastError: null, socket: null, timer: null, self: null };
  }
  return g.__skladDiscovery;
}

export function setDiscoveryError(message: string | null): void {
  runtime().lastError = message;
}

export function discoveryError(): string | null {
  return runtime().lastError;
}

export function upsertDevice(device: DiscoveredDevice): void {
  const fingerprint = normalizeFingerprint(device.fingerprint);
  runtime().devices.set(fingerprint, { ...device, fingerprint, lastSeen: device.lastSeen || Date.now() });
  if (device.source === "manual") void persistManual().catch(() => undefined);
}

export function removeDevice(fingerprint: string): void {
  runtime().devices.delete(normalizeFingerprint(fingerprint));
}

export function getDevice(fingerprint: string): DiscoveredDevice | null {
  const device = runtime().devices.get(normalizeFingerprint(fingerprint));
  if (!device) return null;
  if (device.source === "multicast" && Date.now() - device.lastSeen > 45_000) return null;
  return device;
}

export function listDevices(): DiscoveredDevice[] {
  const now = Date.now();
  return [...runtime().devices.values()]
    .filter((device) => device.source !== "multicast" || now - device.lastSeen <= 45_000)
    .sort((a, b) => Number(b.demo) - Number(a.demo) || a.alias.localeCompare(b.alias, "ru"));
}

export async function loadManualDevices(): Promise<void> {
  try {
    const text = await readFile(peersPath(), "utf8");
    const parsed = JSON.parse(text) as { devices?: DiscoveredDevice[] };
    for (const device of parsed.devices ?? []) {
      if (!device || device.source !== "manual" || typeof device.fingerprint !== "string") continue;
      upsertDevice({ ...device, demo: false, source: "manual", lastSeen: Date.now() });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      setDiscoveryError("Не удалось прочитать сохранённые IP LocalSend.");
    }
  }
}

export async function addDeviceByIp(address: string, port: number, self: DeviceInfo): Promise<DiscoveredDevice> {
  const ip = assertIpv4(address);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, "Порт от 1 до 65535.");
  const httpsError = await tryRegister({ address: ip, port, protocol: "https", fingerprint: "" }, self, true);
  if (httpsError.device) {
    upsertDevice(httpsError.device);
    setDiscoveryError(null);
    return httpsError.device;
  }
  const httpResult = await tryRegister({ address: ip, port, protocol: "http", fingerprint: "http" }, self, false);
  if (httpResult.device) {
    upsertDevice(httpResult.device);
    setDiscoveryError(null);
    return httpResult.device;
  }
  const message = `Не удалось связаться с ${ip}:${port}. ${httpsError.error || ""} ${httpResult.error || ""}`.trim();
  setDiscoveryError(message);
  throw new AppError(502, message);
}

export function startMulticast(getSelf: () => DeviceInfo): void {
  const state = runtime();
  state.self = getSelf;
  if (state.socket) return;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  state.socket = socket;
  socket.on("error", (error) => {
    setDiscoveryError(`Мультикаст недоступен (${error.message}). Добавьте устройство по IP.`);
  });
  socket.on("message", (message, rinfo) => {
    let parsed: DeviceInfo;
    try {
      parsed = JSON.parse(message.toString("utf8")) as DeviceInfo;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.alias !== "string" || typeof parsed.fingerprint !== "string") return;
    const self = state.self?.();
    if (self && normalizeFingerprint(parsed.fingerprint) === normalizeFingerprint(self.fingerprint)) return;
    upsertDevice({
      alias: parsed.alias,
      address: normalizeAddress(rinfo.address),
      port: Number(parsed.port) || LOCALSEND_PORT,
      protocol: parsed.protocol === "http" ? "http" : "https",
      fingerprint: parsed.fingerprint,
      deviceModel: parsed.deviceModel ?? null,
      deviceType: parsed.deviceType ?? null,
      version: parsed.version || "",
      demo: false,
      source: "multicast",
      lastSeen: Date.now(),
    });
    if (parsed.announce === true && self) {
      const reply = Buffer.from(JSON.stringify({ ...self, announce: false }));
      socket.send(reply, rinfo.port || LOCALSEND_PORT, rinfo.address);
    }
  });
  socket.bind(LOCALSEND_PORT, () => {
    try {
      socket.addMembership(LOCALSEND_MULTICAST_ADDRESS);
      socket.setMulticastTTL(1);
      announce();
    } catch (error) {
      setDiscoveryError(
        `Мультикаст ${LOCALSEND_MULTICAST_ADDRESS}:${LOCALSEND_PORT} недоступен (${error instanceof Error ? error.message : "ошибка"}). Добавьте устройство по IP.`,
      );
    }
  });
  state.timer = setInterval(announce, 10_000);
}

function announce(): void {
  const state = runtime();
  const self = state.self?.();
  if (!self || !state.socket) return;
  const payload = Buffer.from(JSON.stringify({ ...self, announce: true }));
  state.socket.send(payload, LOCALSEND_PORT, LOCALSEND_MULTICAST_ADDRESS, (error) => {
    if (error) {
      setDiscoveryError(`Мультикаст недоступен (${error.message}). Добавьте устройство по IP.`);
    }
  });
}

async function tryRegister(
  peer: PeerTarget,
  self: DeviceInfo,
  httpsMode: boolean,
): Promise<{ device: DiscoveredDevice | null; error: string | null }> {
  try {
    const info = httpsMode ? await registerWithPeer(peer, self, true) : await registerWithPeer(peer, self, true);
    const fingerprint = httpsMode ? info.certificateFingerprint : info.fingerprint;
    if (!fingerprint) return { device: null, error: "Ответ без отпечатка." };
    const checked = httpsMode
      ? await fetchPeerInfo({ ...peer, fingerprint }, undefined, false).catch(() => null)
      : null;
    if (httpsMode && !checked) return { device: null, error: "Сертификат не закрепился." };
    return {
      device: {
        alias: info.alias,
        address: peer.address,
        port: peer.port,
        protocol: peer.protocol,
        fingerprint,
        deviceModel: info.deviceModel ?? null,
        deviceType: info.deviceType ?? null,
        version: info.version || "",
        demo: false,
        source: "manual",
        lastSeen: Date.now(),
      },
      error: null,
    };
  } catch (error) {
    return { device: null, error: error instanceof Error ? error.message : "нет ответа" };
  }
}

async function persistManual(): Promise<void> {
  const devices = [...runtime().devices.values()].filter((device) => device.source === "manual");
  const file = peersPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

function peersPath(): string {
  return path.join(appDataDir(), "localsend-peers.json");
}

function assertIpv4(value: string): string {
  const ip = value.trim();
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new AppError(400, "Укажите IPv4, например 192.168.1.20.");
  }
  return ip;
}

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
