export function agentGameUrl(env: NodeJS.ProcessEnv, suffix: "/v1/game-mode" | "/v1/game-mode/events"): string | null {
  const raw = env.SKLAD_PC_AGENT_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(suffix, raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseGameMode(value: unknown): "on" | "off" | "auto" | null {
  if (!value || typeof value !== "object") return null;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === "on" || mode === "off" || mode === "auto") return mode;
  return null;
}
