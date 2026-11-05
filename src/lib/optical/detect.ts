import { spawn } from "node:child_process";

import { WINDOWS_DETECT_ARGV, WINDOWS_WMIC_ARGV } from "@/lib/optical/commands";
import { demoDrives } from "@/lib/optical/demo";
import type { CommandSpawn } from "@/lib/optical/runner";
import type { DetectResult, MediaKind, MediaProfile, OpticalDrive } from "@/lib/optical/media";

const IMAPI_MEDIA: Record<number, MediaKind> = {
  0: "empty",
  1: "cd",
  2: "cd",
  3: "cd-rw",
  4: "dvd-r",
  5: "dvd-rw",
  6: "dvd+r",
  7: "dvd+rw",
  8: "dvd+r-dl",
  9: "dvd-r",
  10: "dvd-rw",
  11: "dvd-r-dl",
  13: "dvd+rw",
};

export function mapMediaLabel(raw: string): MediaKind {
  const text = raw.trim().toLowerCase();
  if (!text || /no media|unknown media|empty/.test(text)) return "empty";
  const dual = /dl|dual|double|двойн/.test(text);
  if (/cd-rw|cdrw/.test(text)) return "cd-rw";
  if (text.includes("cd")) return "cd";
  if (dual && (text.includes("+") || text.includes("plus"))) return "dvd+r-dl";
  if (dual && text.includes("dvd")) return "dvd-r-dl";
  if (/dvd\+rw|\+rw|plus rw/.test(text)) return "dvd+rw";
  if (/dvd-rw|dvdrw|-rw/.test(text)) return "dvd-rw";
  if (/dvd\+r|\+r|plus r/.test(text)) return "dvd+r";
  if (text.includes("dvd")) return "dvd-r";
  return "unknown";
}

export function profileForMedia(media: MediaKind): MediaProfile | null {
  switch (media) {
    case "cd":
    case "cd-rw":
      return "cd";
    case "dvd-r":
    case "dvd+r":
    case "dvd-rw":
    case "dvd+rw":
      return "dvd-sl";
    case "dvd-r-dl":
    case "dvd+r-dl":
      return "dvd-dl";
    default:
      return null;
  }
}

export function parseDrutilStatus(text: string): { device: string; media: MediaKind; name: string }[] {
  const found: { device: string; media: MediaKind; name: string }[] = [];
  let pendingName = "";
  let current: { device: string; media: MediaKind; name: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const vendor = line.match(/^\s*(?:(\d+)\s+)?([A-Z][A-Z0-9.+-]{2,})\s{2,}(\S.*?)\s{2,}\S+/);
    if (vendor && !/Type:|Name:|Sessions:/.test(line)) {
      pendingName = `${vendor[2]} ${vendor[3]}`.replace(/\s+/g, " ").trim();
    }
    const named = line.match(/Name:\s*(\/dev\/disk\d+)/);
    const typed = line.match(/Type:\s*(.+?)(?:\s{2,}|$)/);
    if (named) {
      current = {
        device: named[1],
        media: "unknown",
        name: pendingName || "Оптический привод",
      };
      found.push(current);
      pendingName = "";
    }
    if (typed && current) current.media = mapMediaLabel(typed[1]);
  }
  return found;
}

export function parseDrutilList(text: string): { index: string; name: string }[] {
  const rows: { index: string; name: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S.*?)\s{2,}(\S.*?)\s{2,}\S+/);
    if (!match) continue;
    rows.push({ index: match[1], name: `${match[2]} ${match[3]}`.replace(/\s+/g, " ").trim() });
  }
  return rows;
}

export function parseDiskutilInfo(text: string): {
  location: OpticalDrive["location"];
  media: MediaKind | null;
  volumeName: string | null;
  volumeUuid: string | null;
  hardwareSerial: string | null;
} {
  const read = (label: string) => {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"));
    return match ? match[1].trim() : null;
  };
  const locationRaw = (read("Device Location") || "").toLowerCase();
  const location = locationRaw.includes("external") ? "external" : locationRaw.includes("internal") ? "internal" : "unknown";
  const optical = read("Optical Media Type");
  const serial = read("Media Serial Number") || read("Disk Serial") || read("Device Serial Number");
  return {
    location,
    media: optical ? mapMediaLabel(optical) : null,
    volumeName: read("Volume Name"),
    volumeUuid: read("Volume UUID"),
    hardwareSerial: serial,
  };
}

interface WmiRow {
  deviceId?: string;
  name?: string;
  drive?: string;
  mediaLoaded?: boolean;
  mediaType?: string;
  caption?: string;
  pnpDeviceId?: string;
  recorderId?: string;
  imapiMediaType?: number | null;
}

export function parseWindowsDrives(stdout: string): OpticalDrive[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseCimJson(trimmed);
  return parseWmicList(trimmed);
}

function parseCimJson(text: string): OpticalDrive[] {
  const parsed = JSON.parse(text) as WmiRow | WmiRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(rowToDrive).filter((drive): drive is OpticalDrive => drive !== null);
}

function parseWmicList(text: string): OpticalDrive[] {
  const blocks = text.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const row: WmiRow = {};
      for (const line of block.split(/\r?\n/)) {
        const split = line.split("=");
        if (split.length < 2) continue;
        const key = split[0].trim().toLowerCase();
        const value = split.slice(1).join("=").trim();
        if (key === "deviceid") row.deviceId = value;
        if (key === "name" || key === "caption") row.name = value;
        if (key === "drive") row.drive = value;
        if (key === "medialoaded") row.mediaLoaded = /true|1/i.test(value);
        if (key === "mediatype") row.mediaType = value;
        if (key === "pnpdeviceid") row.pnpDeviceId = value;
      }
      return rowToDrive(row);
    })
    .filter((drive): drive is OpticalDrive => drive !== null);
}

function rowToDrive(row: WmiRow): OpticalDrive | null {
  const device = row.drive || row.deviceId || "";
  if (!device && !row.name) return null;
  const loaded = row.mediaLoaded === true;
  let media: MediaKind = "empty";
  if (loaded) {
    if (typeof row.imapiMediaType === "number" && IMAPI_MEDIA[row.imapiMediaType]) {
      media = IMAPI_MEDIA[row.imapiMediaType];
    } else {
      media = "unknown";
    }
  }
  const pnp = row.pnpDeviceId || "";
  return {
    id: `win32:${device || row.name}`,
    name: row.caption || row.name || "Оптический привод",
    device: device || row.deviceId || "",
    driveIndex: null,
    location: /USB/i.test(pnp) ? "external" : "internal",
    media,
    volumeName: null,
    volumeUuid: null,
    hardwareSerial: null,
    rewritable: media === "cd-rw" || media === "dvd-rw" || media === "dvd+rw",
    suggestedProfile: profileForMedia(media),
    demo: false,
    platform: "win32",
    recorderId: row.recorderId || device || null,
  };
}

export async function detectDrives(options: {
  platform: NodeJS.Platform;
  demo: boolean;
  exec?: CommandSpawn;
}): Promise<DetectResult> {
  if (options.demo) {
    return {
      status: "demo",
      drives: demoDrives(),
      detail: "Демо-приводы. Это не оборудование этой машины, запись на диск не выполняется.",
    };
  }
  if (options.platform === "darwin") {
    return {
      status: "no-drive",
      drives: [],
      detail: "Оптический привод не найден. На Mac локального привода нет: запись идёт через агент Windows.",
    };
  }
  if (options.platform !== "win32") {
    return { status: "no-drive", drives: [], detail: "Оптический привод не найден." };
  }
  const exec = options.exec;
  if (!exec) return { status: "no-drive", drives: [], detail: "Оптический привод не найден." };
  try {
    return await detectWindows(exec);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /не найдена/i.test(String((error as Error).message || ""));
    return {
      status: "no-drive",
      drives: [],
      detail: missing ? "Оптический привод не найден." : "Оптический привод не найден.",
    };
  }
}

async function detectWindows(exec: CommandSpawn): Promise<DetectResult> {
  let stdout = "";
  try {
    const result = await exec([...WINDOWS_DETECT_ARGV]);
    stdout = result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const wmic = await exec([...WINDOWS_WMIC_ARGV]);
    stdout = wmic.stdout;
  }
  const drives = parseWindowsDrives(stdout);
  if (drives.length === 0) return { status: "no-drive", drives: [], detail: "Оптический привод не найден." };
  return { status: "ok", drives, detail: "" };
}

export function spawnExec(): CommandSpawn {
  return (argv) =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(Object.assign(new Error(`Утилита не найдена: ${argv[0]}`), { code: "ENOENT" }));
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr, mock: false });
      });
    });
}
