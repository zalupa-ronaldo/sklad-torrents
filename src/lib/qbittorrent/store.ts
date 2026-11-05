import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { demoHosts } from "@/lib/qbittorrent/demo-data";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { normalizeRemotePath } from "@/lib/qbittorrent/paths";
import type { HostOs, HostPublic, HostRecord, MoveMark, PathPreset } from "@/lib/qbittorrent/types";
import { normalizeBaseUrl } from "@/lib/qbittorrent/urls";

interface HostsFile {
  hosts: HostRecord[];
}

interface MarksFile {
  marks: MoveMark[];
}

export interface HostDraft {
  name: string;
  baseUrl: string;
  username: string;
  password?: string;
  os: HostOs;
  pathPresets?: PathPreset[];
}

export function dataDir(): string {
  return process.env.SKLAD_DATA_DIR || path.join(process.cwd(), "data");
}

export function toPublic(host: HostRecord): HostPublic {
  return {
    id: host.id,
    name: host.name,
    kind: host.kind,
    baseUrl: host.baseUrl,
    username: host.username,
    os: host.os,
    pathPresets: host.pathPresets,
    hasPassword: host.password.length > 0,
  };
}

export async function loadHosts(): Promise<HostRecord[]> {
  const custom = await readCustomHosts();
  return [...demoHosts(), ...custom];
}

export async function getHost(id: string): Promise<HostRecord | null> {
  const hosts = await loadHosts();
  return hosts.find((host) => host.id === id) ?? null;
}

export async function requireHost(id: string): Promise<HostRecord> {
  const host = await getHost(id);
  if (!host) throw new QbittorrentError("not_found", "Хост не найден.");
  return host;
}

export async function createHost(draft: HostDraft): Promise<HostPublic> {
  const host = recordFromDraft(draft, `host-${randomUUID()}`, true);
  const hosts = await readCustomHosts();
  hosts.push(host);
  await writeCustomHosts(hosts);
  return toPublic(host);
}

export async function updateHost(id: string, draft: HostDraft): Promise<HostPublic> {
  const demo = demoHosts().find((host) => host.id === id);
  if (demo) {
    throw new QbittorrentError("validation", "Демо-хост нельзя изменить. Можно сбросить его раздачи.");
  }
  const hosts = await readCustomHosts();
  const index = hosts.findIndex((host) => host.id === id);
  if (index < 0) throw new QbittorrentError("not_found", "Хост не найден.");
  const current = hosts[index];
  const password = draft.password && draft.password.length > 0 ? draft.password : current.password;
  hosts[index] = recordFromDraft({ ...draft, password }, id, false);
  await writeCustomHosts(hosts);
  return toPublic(hosts[index]);
}

export async function deleteHost(id: string): Promise<void> {
  if (demoHosts().some((host) => host.id === id)) {
    throw new QbittorrentError("validation", "Демо-хост нельзя удалить. Его раздачи можно сбросить.");
  }
  const hosts = await readCustomHosts();
  const next = hosts.filter((host) => host.id !== id);
  if (next.length === hosts.length) throw new QbittorrentError("not_found", "Хост не найден.");
  await writeCustomHosts(next);
  const marks = (await loadMarks()).filter((mark) => mark.hostId !== id);
  await writeMarks(marks);
}

export async function loadMarks(): Promise<MoveMark[]> {
  const file = await readJson<MarksFile>(marksPath(), { marks: [] });
  if (!file || !Array.isArray(file.marks)) return [];
  return file.marks.filter((mark) => mark && typeof mark.hostId === "string" && typeof mark.hash === "string");
}

export async function saveMark(mark: MoveMark): Promise<void> {
  const marks = await loadMarks();
  const next = marks.filter((item) => !(item.hostId === mark.hostId && item.hash === mark.hash));
  next.push(mark);
  await writeMarks(next);
}

export async function removeMark(hostId: string, hash: string): Promise<void> {
  const marks = await loadMarks();
  await writeMarks(marks.filter((mark) => !(mark.hostId === hostId && mark.hash === hash)));
}

function recordFromDraft(draft: HostDraft, id: string, requirePassword: boolean): HostRecord {
  const name = draft.name.trim();
  if (!name) throw new QbittorrentError("validation", "Укажите имя хоста.");
  if (name.length > 80) throw new QbittorrentError("validation", "Имя хоста длиннее 80 символов.");
  if (draft.os !== "darwin" && draft.os !== "win32") {
    throw new QbittorrentError("validation", "Выберите систему: macOS или Windows.");
  }
  const username = draft.username.trim();
  if (!username) throw new QbittorrentError("validation", "Укажите имя пользователя Web UI.");
  const password = draft.password ?? "";
  if (requirePassword && !password) {
    throw new QbittorrentError("validation", "Укажите пароль Web UI.");
  }
  return {
    id,
    name,
    kind: "http",
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    username,
    password,
    os: draft.os,
    pathPresets: cleanPresets(draft.os, draft.pathPresets),
  };
}

function cleanPresets(os: HostOs, presets: PathPreset[] | undefined): PathPreset[] {
  if (!Array.isArray(presets)) return [];
  const cleaned: PathPreset[] = [];
  for (const preset of presets.slice(0, 24)) {
    const presetPath = normalizeRemotePath(os, String(preset?.path || ""));
    if (!presetPath) continue;
    cleaned.push({
      id: typeof preset.id === "string" && preset.id ? preset.id : randomUUID(),
      label: String(preset.label || "").trim().slice(0, 60) || "Каталог",
      path: presetPath,
    });
  }
  return cleaned;
}

async function readCustomHosts(): Promise<HostRecord[]> {
  const file = await readJson<HostsFile>(hostsPath(), { hosts: [] });
  if (!file || !Array.isArray(file.hosts)) return [];
  return file.hosts.filter(isStoredHost);
}

function isStoredHost(value: unknown): value is HostRecord {
  if (!value || typeof value !== "object") return false;
  const host = value as HostRecord;
  return host.kind === "http" && typeof host.id === "string" && typeof host.baseUrl === "string" && typeof host.name === "string";
}

async function writeCustomHosts(hosts: HostRecord[]): Promise<void> {
  await writeJson(hostsPath(), { hosts });
}

async function writeMarks(marks: MoveMark[]): Promise<void> {
  await writeJson(marksPath(), { marks });
}

function hostsPath(): string {
  return path.join(dataDir(), "hosts.json");
}

function marksPath(): string {
  return path.join(dataDir(), "move-marks.json");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new QbittorrentError("api", "Не удалось прочитать локальные настройки Склада.");
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
