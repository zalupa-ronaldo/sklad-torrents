/**
 * Steam client family. Exact file names only: a game whose name starts with
 * "Steam" (SteamWorld Dig) is not the client. No Steam source is copied.
 */
export const STEAM_PROCESSES: ReadonlySet<string> = new Set([
  "steam.exe",
  "steamwebhelper.exe",
  "steamservice.exe",
  "steamerrorreporter.exe",
  "steamerrorreporter64.exe",
  "gameoverlayui.exe",
  "gameoverlayui64.exe",
  "streaming_client.exe",
  "steamxboxutil.exe",
  "steamxboxutil64.exe",
  "steamtours.exe",
  "steamsysinfo.exe",
  "vrserver.exe",
  "vrcompositor.exe",
  "vrmonitor.exe",
  "vrwebhelper.exe",
]);

export function processBaseName(name: string): string {
  const trimmed = String(name || "").trim();
  const parts = trimmed.split(/[/\\]/);
  return (parts[parts.length - 1] || trimmed).toLowerCase();
}

export function isSteamProcess(name: string): boolean {
  return STEAM_PROCESSES.has(processBaseName(name));
}
