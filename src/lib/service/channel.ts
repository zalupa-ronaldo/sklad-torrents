import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { JobError } from "@/lib/jobs/errors";
import { dataDir, getHost, updateHost } from "@/lib/qbittorrent/store";
import {
  CHANNEL_TEXT,
  channelErrorForProbe,
  emptyChannel,
  project,
  reconcile,
  type ChannelFile,
  type ChannelLinkView,
  type HeartbeatInput,
  type RepairAction,
} from "@/lib/service/channel-view";

export type { ChannelLinkView, HeartbeatInput, RepairAction };
export { CHANNEL_TEXT };

const chains = new Map<string, Promise<void>>();

async function exclusive<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(directory) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(directory, run.then(() => undefined, () => undefined));
  return run;
}

export async function tickChannel(directory = dataDir(), now = Date.now()): Promise<ChannelLinkView> {
  return exclusive(directory, async () => {
    const file = await ensureChannel(directory, now);
    return project(file, now);
  });
}

export async function applyHeartbeat(
  input: HeartbeatInput,
  directory = dataDir(),
  now = Date.now(),
): Promise<{ link: ChannelLinkView; actions: RepairAction[] }> {
  return exclusive(directory, async () => {
    const current = await ensureChannel(directory, now);
    const { file, actions } = reconcile(current, input, now);
    await pinStableBaseUrl(file);
    await writeChannel(directory, file);
    return { link: project(file, now), actions };
  });
}

export async function probeChannelError(
  input: { id?: string; baseUrl?: string },
  directory = dataDir(),
  now = Date.now(),
): Promise<string | null> {
  return channelErrorForProbe(await readChannel(directory), input, now);
}

export function parseChannelBody(body: unknown): HeartbeatInput | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.role !== "channel") return null;
  if (record.worker !== "pc-agent") throw new JobError("validation", CHANNEL_TEXT.agentMissing);
  return {
    worker: "pc-agent",
    wslIp: parseIpv4(record.wslIp),
    socatOk: requiredBool(record.socatOk, "socatOk"),
    portproxyOk: requiredBool(record.portproxyOk, "portproxyOk"),
    qbittorrentOk: requiredBool(record.qbittorrentOk, "qbittorrentOk"),
    handbrakeOk: requiredBool(record.handbrakeOk, "handbrakeOk"),
    macQbittorrentOk: optionalBool(record.macQbittorrentOk, "macQbittorrentOk"),
    macHandbrakeOk: optionalBool(record.macHandbrakeOk, "macHandbrakeOk"),
    stableBaseUrl: parseStableUrl(record.stableBaseUrl),
  };
}

async function ensureChannel(directory: string, now: number): Promise<ChannelFile> {
  const existing = await readChannel(directory);
  const qbHostId = process.env.SKLAD_QB_CHANNEL_HOST_ID?.trim() || null;
  if (!existing) {
    const created = emptyChannel(now, qbHostId);
    await writeChannel(directory, created);
    return created;
  }
  if (qbHostId && existing.qbHostId !== qbHostId) {
    const next = { ...existing, qbHostId };
    await writeChannel(directory, next);
    return next;
  }
  return existing;
}

async function readChannel(directory: string): Promise<ChannelFile | null> {
  try {
    const text = await readFile(path.join(directory, "channel.json"), "utf8");
    const parsed = JSON.parse(text) as Partial<ChannelFile>;
    if (parsed.version !== 1) return null;
    return { ...emptyChannel(Date.now()), ...parsed, version: 1 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeChannel(directory: string, file: ChannelFile): Promise<void> {
  await mkdir(directory, { recursive: true });
  const tmp = path.join(directory, `.channel.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmp, path.join(directory, "channel.json"));
}

async function pinStableBaseUrl(file: ChannelFile): Promise<void> {
  if (file.baseUrlPinned || !file.qbHostId || !file.stableBaseUrl || !file.currentWslIp) return;
  try {
    const host = await getHost(file.qbHostId);
    if (!host || host.kind !== "http") return;
    const current = new URL(host.baseUrl);
    const stable = new URL(file.stableBaseUrl);
    if (current.origin === stable.origin) {
      file.baseUrlPinned = true;
      return;
    }
    const pointsAtWsl = current.hostname === file.currentWslIp || current.hostname === file.lastWslIp;
    if (!pointsAtWsl) return;
    await updateHost(host.id, {
      name: host.name,
      baseUrl: file.stableBaseUrl,
      username: host.username,
      password: host.password,
      os: host.os,
      pathPresets: host.pathPresets,
    });
    file.baseUrlPinned = true;
  } catch {
    // Host storage stays as it is. The heartbeat still records the new WSL address.
  }
}

function parseIpv4(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !isIpv4(value)) {
    throw new JobError("validation", "Адрес WSL должен быть IPv4.");
  }
  return value;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function requiredBool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new JobError("validation", `Поле ${name} должно быть да или нет.`);
  return value;
}

function optionalBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requiredBool(value, name);
}

function parseStableUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new JobError("validation", "Стабильный адрес должен быть http или https.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new JobError("validation", "Стабильный адрес должен быть http или https.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobError("validation", "Стабильный адрес должен быть http или https.");
  }
  if (url.username || url.password) {
    throw new JobError("validation", "Логин и пароль не пишите в адресе канала.");
  }
  return url.origin;
}
