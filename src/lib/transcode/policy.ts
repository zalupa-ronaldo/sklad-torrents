import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";
import type { JobHost } from "@/lib/jobs/model";
import { clampLimit, DEFAULT_MACHINE_LIMIT, type MachineLimit } from "@/lib/transcode/workload";

export interface EncodePolicy {
  replaceOriginal: boolean;
  machines: Record<JobHost, MachineLimit>;
}

function empty(): EncodePolicy {
  return {
    replaceOriginal: false,
    machines: {
      "mac-local": { ...DEFAULT_MACHINE_LIMIT },
      "pc-agent": { ...DEFAULT_MACHINE_LIMIT },
      "linux-local": { ...DEFAULT_MACHINE_LIMIT },
    },
  };
}

export function policyFromUnknown(value: unknown): EncodePolicy {
  const base = empty();
  if (!value || typeof value !== "object") return base;
  const raw = value as { replaceOriginal?: unknown; machines?: unknown };
  base.replaceOriginal = raw.replaceOriginal === true;
  if (!raw.machines || typeof raw.machines !== "object") return base;
  for (const host of ["mac-local", "pc-agent", "linux-local"] as const) {
    const item = (raw.machines as Record<string, unknown>)[host];
    base.machines[host] = clampLimit(item && typeof item === "object" ? item as Partial<MachineLimit> : null);
  }
  return base;
}

export async function readEncodePolicy(directory = dataDir()): Promise<EncodePolicy> {
  try {
    return policyFromUnknown(JSON.parse(await readFile(path.join(directory, "encode-policy.json"), "utf8")));
  } catch {
    return empty();
  }
}

export async function writeEncodePolicy(patch: { replaceOriginal?: boolean; host?: JobHost; limit?: Partial<MachineLimit> }, directory = dataDir()): Promise<EncodePolicy> {
  const current = await readEncodePolicy(directory);
  if (patch.replaceOriginal !== undefined) current.replaceOriginal = patch.replaceOriginal === true;
  if (patch.host && patch.limit) current.machines[patch.host] = clampLimit({ ...current.machines[patch.host], ...patch.limit });
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "encode-policy.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(current), "utf8");
  await rename(tmp, file);
  return current;
}
