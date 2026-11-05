import { isToolHostId, type ToolHostId, type ToolOs } from "@/addons/media-games/types";

export function readToolQuery(params: { get(name: string): string | null }): {
  hostId: ToolHostId;
  path: string;
  name: string;
  os: ToolOs;
} {
  const host = params.get("host");
  const osParam = params.get("os");
  const os: ToolOs = osParam === "win32" || host === "pc-agent" ? "win32" : "darwin";
  const hostId: ToolHostId = host && isToolHostId(host) ? host : os === "win32" ? "pc-agent" : "mac-local";
  return {
    hostId,
    os: hostId === "pc-agent" ? "win32" : "darwin",
    path: params.get("path") || params.get("source") || "",
    name: params.get("name") ?? "",
  };
}

export function toolHostForOs(os: ToolOs): ToolHostId {
  return os === "win32" ? "pc-agent" : "mac-local";
}

export function mediaToolsQuery(input: { os: ToolOs; path: string; name: string }): string {
  const params = new URLSearchParams({
    os: input.os,
    host: toolHostForOs(input.os),
    path: input.path,
    name: input.name,
  });
  return params.toString();
}

export function handbrakeHref(input: { os: ToolOs; path: string; name: string }): string {
  return `/tools/transcode?${mediaToolsQuery(input)}`;
}

export function moveGameHref(input: { os: ToolOs; path: string; name: string }): string {
  return `/tools/move?${mediaToolsQuery(input)}`;
}

export function torrentReadyForMedia(
  progress: number,
  files: { progress: number; priority: number }[],
): boolean {
  if (progress >= 0.999) return true;
  const wanted = files.filter((file) => file.priority > 0);
  return wanted.length > 0 && wanted.every((file) => file.progress >= 0.999);
}
