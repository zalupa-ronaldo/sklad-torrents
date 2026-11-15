import type { JobHost } from "@/lib/jobs/model";

export function localJobHost(platform: NodeJS.Platform = process.platform): JobHost | null {
  if (platform === "darwin") return "mac-local";
  if (platform === "win32") return "pc-agent";
  if (platform === "linux") return "linux-local";
  return null;
}

export function localEncodeOs(platform: NodeJS.Platform = process.platform): "darwin" | "win32" | "linux" | null {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return null;
}

export function hostFacts(platform: NodeJS.Platform = process.platform): { host: JobHost; state: "local" | "unconfigured"; reason: string }[] {
  const local = localJobHost(platform);
  const rows: { host: JobHost; name: string }[] = [
    { host: "pc-agent", name: "Windows" },
    { host: "mac-local", name: "Mac" },
    { host: "linux-local", name: "Linux" },
  ];
  return rows.map((row) => row.host === local
    ? { host: row.host, state: "local", reason: `Этот процесс работает на ${row.name}. Метка другой системы не подставляется.` }
    : { host: row.host, state: "unconfigured", reason: `${row.name} этой командой не запускался. LAN по умолчанию выключен.` });
}
