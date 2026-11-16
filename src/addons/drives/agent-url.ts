import type { AgentEndpoint } from "@/addons/drives/types";

/** Mac drive-agent on the same machine, outside Docker. */
export const HOST_MAC_DRIVE_AGENT_URL = "http://127.0.0.1:4371";

/** Mac drive-agent on the Docker host. The panel container must not use 127.0.0.1 for it. */
export const DOCKER_MAC_DRIVE_AGENT_URL = "http://host.docker.internal:4371";

type MacAgentEnv = NodeJS.ProcessEnv | { SKLAD_MAC_AGENT_URL?: string };

export function macDriveAgentUrl(env: MacAgentEnv = process.env): string {
  const configured = env.SKLAD_MAC_AGENT_URL?.trim();
  return configured || HOST_MAC_DRIVE_AGENT_URL;
}

function isLoopbackMacDriveAgent(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    return loopback && parsed.port === "4371";
  } catch {
    return false;
  }
}

/**
 * When SKLAD_MAC_AGENT_URL is set, that address is the Mac drive-agent.
 * A saved loopback :4371 points at the panel container, not the host process.
 * Other agents, including Windows :4372, stay as stored.
 */
export function applyMacDriveAgentUrl(agents: readonly AgentEndpoint[], env: MacAgentEnv = process.env): AgentEndpoint[] {
  const mac = env.SKLAD_MAC_AGENT_URL?.trim();
  if (!mac) return agents.map((agent) => ({ ...agent }));
  return agents.map((agent) =>
    agent.id === "mac-mini" || isLoopbackMacDriveAgent(agent.url) ? { ...agent, url: mac } : { ...agent },
  );
}
