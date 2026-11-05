import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";

export async function demoFromEnv(): Promise<boolean> {
  const flag = process.env.SKLAD_OPTICAL_DEMO;
  return flag === "1" || flag === "true";
}

export async function readDemoSetting(): Promise<boolean> {
  try {
    const text = await readFile(path.join(dataDir(), "optical-settings.json"), "utf8");
    const parsed = JSON.parse(text) as { demo?: boolean };
    return parsed.demo === true;
  } catch {
    return false;
  }
}

export async function isDemoEnabled(): Promise<boolean> {
  if (await demoFromEnv()) return true;
  return readDemoSetting();
}

export async function writeDemoSetting(demo: boolean): Promise<void> {
  const file = path.join(dataDir(), "optical-settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ demo }, null, 2), "utf8");
  await rename(tmp, file);
}
