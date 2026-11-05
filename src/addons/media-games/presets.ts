import type { CompactAlgorithm } from "@/addons/media-games/types";

export interface HandbrakePreset {
  id: string;
  label: string;
  /** Name passed to HandBrakeCLI --preset. Built-in preset, not a bundled file. */
  handbrakeName: string;
}

export const HANDBRAKE_PRESETS: readonly HandbrakePreset[] = [
  { id: "fast-1080p", label: "Быстрый 1080p", handbrakeName: "Fast 1080p30" },
  { id: "compat", label: "Совместимый", handbrakeName: "Very Fast 1080p30" },
  { id: "hq-1080p", label: "Высокое качество", handbrakeName: "HQ 1080p30 Surround" },
];

export function findHandbrakePreset(id: string): HandbrakePreset | null {
  return HANDBRAKE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export const COMPACT_ALGORITHMS: readonly { id: CompactAlgorithm; label: string; hint: string }[] = [
  { id: "LZX", label: "LZX", hint: "Сильнее всего, дольше" },
  { id: "XPRESS16K", label: "XPRESS16K", hint: "Баланс" },
  { id: "XPRESS8K", label: "XPRESS8K", hint: "Быстрее" },
  { id: "XPRESS4K", label: "XPRESS4K", hint: "Самый быстрый" },
];

export function isCompactAlgorithm(value: string): value is CompactAlgorithm {
  return COMPACT_ALGORITHMS.some((item) => item.id === value);
}
