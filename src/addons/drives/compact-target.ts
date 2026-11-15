import { buildCompactArgv, DEFAULT_COMPACT_EXE, isNtfsPath } from "@/addons/media-games/compact";
import { isCompactAlgorithm } from "@/addons/media-games/presets";
import type { CompactAlgorithm } from "@/addons/media-games/types";
import { safeRelativePath } from "@/addons/drives/transfer/paths";

export const COMPACT_ALGORITHMS: readonly CompactAlgorithm[] = ["XPRESS16K", "XPRESS8K", "XPRESS4K", "LZX"];

const INJECTION = /[\0\r\n"&|<>^]/;

/** Well-known Windows roots. A game folder named WindowsNoEditor is not one of these. */
const SYSTEM_ROOT = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\system volume information(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin(\\|$)/i,
  /^[a-z]:\\\$winreagent(\\|$)/i,
  /^[a-z]:\\recovery(\\|$)/i,
  /^[a-z]:\\perflogs(\\|$)/i,
  /^[a-z]:\\documents and settings(\\|$)/i,
];

export function systemCompactReason(absolute: string): string | null {
  const path = absolute.replace(/\//g, "\\");
  if (/^[a-z]:\\?$/i.test(path)) return "Нельзя сжимать корень диска целиком.";
  if (SYSTEM_ROOT.some((pattern) => pattern.test(path))) {
    return "Системный каталог Windows не сжимается.";
  }
  const segments = path.split("\\").filter(Boolean).slice(1);
  if (segments.some((part) => /^system volume information$/i.test(part) || part === "$Recycle.Bin" || part === "$WinREAgent")) {
    return "Системный каталог Windows не сжимается.";
  }
  return null;
}

export function windowsAbsolute(mount: string, relative: string): string | null {
  const rel = safeRelativePath(relative);
  if (!rel) return null;
  if (INJECTION.test(rel) || INJECTION.test(mount)) return null;
  let root = mount.trim().replace(/\//g, "\\");
  if (/^[A-Za-z]:$/.test(root)) root += "\\";
  if (!/^[A-Za-z]:\\/.test(root)) return null;
  const suffix = rel.replace(/\//g, "\\");
  const full = root.endsWith("\\") ? `${root}${suffix}` : `${root}\\${suffix}`;
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  if (INJECTION.test(full) || full.includes("..")) return null;
  return full;
}

export interface CompactPlanInput {
  confirm: boolean;
  algorithm: string;
  os: "darwin" | "win32" | "linux";
  filesystem: string;
  online: boolean;
  mount: string;
  relativePath: string;
  mode: "mock" | "agents";
  agentUrl: string | null;
}

export interface CompactPlan {
  ok: true;
  absolute: string;
  algorithm: CompactAlgorithm;
  argv: string[];
  agentUrl: string;
}

export interface CompactRefusal {
  ok: false;
  status: number;
  message: string;
}

export function planVolumeCompact(input: CompactPlanInput): CompactPlan | CompactRefusal {
  if (input.confirm !== true) {
    return { ok: false, status: 400, message: "Нужно явное подтверждение папки и алгоритма. Сжатие не запускалось." };
  }
  if (input.mode === "mock") {
    return { ok: false, status: 400, message: "Это демонстрационный каталог. Сжатие Windows не запускалось." };
  }
  if (!input.online) {
    return { ok: false, status: 409, message: "Диск не подключён. Сжатие не запускалось." };
  }
  if (input.os !== "win32" || !/ntfs/i.test(input.filesystem)) {
    return {
      ok: false,
      status: 400,
      message: "CompactGUI работает только на NTFS в Windows. На Mac, APFS и других томах сжатие недоступно и не запускалось.",
    };
  }
  if (!isCompactAlgorithm(input.algorithm)) {
    return { ok: false, status: 400, message: "Неизвестный алгоритм сжатия. Сжатие не запускалось." };
  }
  const absolute = windowsAbsolute(input.mount, input.relativePath);
  if (!absolute || !isNtfsPath(absolute)) {
    return { ok: false, status: 400, message: "Путь не находится внутри тома Windows. Сжатие не запускалось." };
  }
  const blocked = systemCompactReason(absolute);
  if (blocked) return { ok: false, status: 400, message: `${blocked} Сжатие не запускалось.` };
  if (!input.agentUrl) {
    return { ok: false, status: 503, message: "Нет адреса drive-agent Windows. Сжатие не запускалось." };
  }
  let agent: URL;
  try {
    agent = new URL(input.agentUrl);
  } catch {
    return { ok: false, status: 400, message: "Адрес агента Windows некорректный. Сжатие не запускалось." };
  }
  if (agent.port === "4730") {
    return {
      ok: false,
      status: 503,
      message: "Порт 4730 — отдельный job-агент, он не запущен и для сжатия не используется. Нужен drive-agent Windows (порт 4372). Сжатие не запускалось.",
    };
  }
  let argv: string[];
  try {
    argv = buildCompactArgv({ os: "win32", binary: DEFAULT_COMPACT_EXE, folder: absolute, algorithm: input.algorithm });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Путь не подходит для NTFS.";
    return { ok: false, status: 400, message: `${message} Сжатие не запускалось.` };
  }
  if (argv[0] !== DEFAULT_COMPACT_EXE || argv[1] !== "/C" || !argv[2]?.startsWith("/EXE:") || argv[3] !== `/S:${absolute}`) {
    return { ok: false, status: 400, message: "Команда сжатия не совпала с системной программой Windows. Сжатие не запускалось." };
  }
  return { ok: true, absolute, algorithm: input.algorithm, argv, agentUrl: input.agentUrl };
}

export function compactExplanation(input: {
  kind: "file" | "dir";
  online: boolean;
  os: "darwin" | "win32" | null;
  filesystem: string;
  displayPath: string;
}): string | null {
  if (input.kind !== "dir") return "Сжимается папка целиком, не отдельный файл из таблицы.";
  if (!input.online) return "Диск не подключён. Сжатие не запускалось.";
  if (input.os !== "win32" || !/ntfs/i.test(input.filesystem) || !/^[A-Za-z]:\\/.test(input.displayPath)) {
    return "CompactGUI работает только на NTFS в Windows. На Mac и APFS кнопка ничего не меняет.";
  }
  return systemCompactReason(input.displayPath);
}
