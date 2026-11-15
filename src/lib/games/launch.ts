import path from "node:path";

import type { ShelfPlatform } from "@/lib/games/platforms";
import { absoluteOwnerPath, pathStyle } from "@/lib/games/owner-path";

export type LaunchKind = "native" | "emulator" | "port";
export type ShelfMachine = "mac-local" | "pc-agent";

export interface LaunchTools {
  ppsspp: string | null;
  pcsx2: string | null;
  shadps4: string | null;
  ryujinx: string | null;
  openGothic: string | null;
}

export interface LaunchButton {
  program: string;
  kind: LaunchKind;
  kindLabel: string;
  machine: ShelfMachine;
  machineLabel: string;
  argv: string[];
  ready: boolean;
  reason: string;
  firmwareNote: string;
}

export const FIRMWARE_NOTE =
  "Прошивки и ключи не скачиваются. Если эмулятору они нужны, укажите путь к своим файлам на диске.";

const KIND_LABEL: Record<LaunchKind, string> = {
  native: "нативно",
  emulator: "эмулятор",
  port: "порт",
};

const EMULATOR_NAME = {
  psp: "PPSSPP",
  ps2: "PCSX2",
  ps4: "shadPS4",
  switch: "Ryujinx",
} as const;

export function emptyLaunchTools(): LaunchTools {
  return { ppsspp: null, pcsx2: null, shadps4: null, ryujinx: null, openGothic: null };
}

export function machineOf(filePath: string): ShelfMachine {
  return pathStyle(filePath) === "win32" ? "pc-agent" : "mac-local";
}

export function machineLabel(machine: ShelfMachine): string {
  return machine === "pc-agent" ? "Windows PC" : "Mac";
}

export function isGothicPort(name: string): boolean {
  return /gothic/i.test(name) && !/god of war/i.test(name);
}

/** One launch button. The program is the port if the owner has it, otherwise the emulator or the native game. */
export function planLaunch(input: {
  name: string;
  platform: ShelfPlatform;
  contentPath: string;
  tools: LaunchTools;
  firmwarePath?: string | null;
  keysPath?: string | null;
}): LaunchButton {
  const firmware = readFirmware(input.firmwarePath, input.keysPath);
  if (!firmware.ok) {
    return button({
      program: programFor(input.platform, input.name, input.tools),
      kind: kindFor(input.platform, input.name, input.tools),
      machine: machineOf(input.contentPath),
      argv: [],
      ready: false,
      reason: firmware.reason,
    });
  }

  if (isGothicPort(input.name) && input.tools.openGothic) {
    const executable = input.tools.openGothic;
    return button({
      program: programFromPath(executable, "OpenGothic"),
      kind: "port",
      machine: machineOf(executable),
      argv: [executable, "--gamedir", input.contentPath],
      ready: true,
      reason: "Запуск через порт OpenGothic.",
    });
  }

  const emulator = emulatorTool(input.platform, input.tools);
  if (emulator) {
    if (!emulator.path) {
      return button({
        program: emulator.name,
        kind: "emulator",
        machine: machineOf(input.contentPath),
        argv: [],
        ready: false,
        reason: `${emulator.name} не указан. Программа не скачивается — укажите путь к ней на диске.`,
      });
    }
    return button({
      program: programFromPath(emulator.path, emulator.name),
      kind: "emulator",
      machine: machineOf(emulator.path),
      argv: [emulator.path, input.contentPath],
      ready: true,
      reason: `Запуск через эмулятор ${emulator.name}.`,
    });
  }

  if (input.platform === "macos") {
    return button({
      program: fileName(input.contentPath).replace(/\.app$/i, "") || "macOS",
      kind: "native",
      machine: "mac-local",
      argv: [input.contentPath],
      ready: Boolean(input.contentPath),
      reason: input.contentPath ? "Нативный запуск на Mac." : "Нет пути к приложению macOS.",
    });
  }

  const exe = input.contentPath;
  const native = input.platform === "windows" && /\.exe$/i.test(exe.replace(/\\/g, "/"));
  return button({
    program: native ? path.win32.basename(exe) : "Windows",
    kind: "native",
    machine: "pc-agent",
    argv: native ? [exe] : [],
    ready: native,
    reason: native ? "Запуск установленной игры." : "Нет exe внутри корня. Произвольная команда не запускается.",
  });
}

export function sanitizeTools(value: unknown): LaunchTools {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ppsspp: absoluteOwnerPath(stringField(record.ppsspp), "PPSSPP"),
    pcsx2: absoluteOwnerPath(stringField(record.pcsx2), "PCSX2"),
    shadps4: absoluteOwnerPath(stringField(record.shadps4), "shadPS4"),
    ryujinx: absoluteOwnerPath(stringField(record.ryujinx), "Ryujinx"),
    openGothic: absoluteOwnerPath(stringField(record.openGothic), "OpenGothic"),
  };
}

function readFirmware(firmwarePath: string | null | undefined, keysPath: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  try {
    absoluteOwnerPath(firmwarePath, "Прошивка");
    absoluteOwnerPath(keysPath, "Ключи");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Прошивки и ключи не скачиваются." };
  }
}

function programFor(platform: ShelfPlatform, name: string, tools: LaunchTools): string {
  if (isGothicPort(name)) return "OpenGothic";
  return emulatorTool(platform, tools)?.name ?? (platform === "macos" ? "macOS" : "Windows");
}

function kindFor(platform: ShelfPlatform, name: string, tools: LaunchTools): LaunchKind {
  if (isGothicPort(name) && tools.openGothic) return "port";
  if (emulatorTool(platform, tools)) return "emulator";
  return "native";
}

function emulatorTool(platform: ShelfPlatform, tools: LaunchTools): { name: string; path: string | null } | null {
  if (platform === "psp") return { name: EMULATOR_NAME.psp, path: tools.ppsspp };
  if (platform === "ps2") return { name: EMULATOR_NAME.ps2, path: tools.pcsx2 };
  if (platform === "ps4") return { name: EMULATOR_NAME.ps4, path: tools.shadps4 };
  if (platform === "switch") return { name: EMULATOR_NAME.switch, path: tools.ryujinx };
  return null;
}

function programFromPath(filePath: string, fallback: string): string {
  const base = fileName(filePath).replace(/\.exe$/i, "").trim();
  if (!base) return fallback;
  if (base.toLowerCase() === fallback.toLowerCase()) return fallback;
  return base;
}

function fileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base;
}

function button(input: {
  program: string;
  kind: LaunchKind;
  machine: ShelfMachine;
  argv: string[];
  ready: boolean;
  reason: string;
}): LaunchButton {
  return {
    program: input.program,
    kind: input.kind,
    kindLabel: KIND_LABEL[input.kind],
    machine: input.machine,
    machineLabel: machineLabel(input.machine),
    argv: input.argv,
    ready: input.ready,
    reason: input.reason,
    firmwareNote: FIRMWARE_NOTE,
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
