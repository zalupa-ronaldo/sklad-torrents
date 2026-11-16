import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DOCKER_MAC_DRIVE_AGENT_URL,
  HOST_MAC_DRIVE_AGENT_URL,
  applyMacDriveAgentUrl,
  macDriveAgentUrl,
} from "@/addons/drives/agent-url";
import { defaultAgentConfig, readAgentConfig } from "@/addons/drives/store";
import type { AgentEndpoint } from "@/addons/drives/types";

const mac: AgentEndpoint = { id: "mac-mini", name: "Mac mini", os: "darwin", url: HOST_MAC_DRIVE_AGENT_URL };
const windows: AgentEndpoint = { id: "windows-pc", name: "Windows PC", os: "win32", url: "http://127.0.0.1:4372" };
const otherMac: AgentEndpoint = { id: "other-mac", name: "Другой Mac", os: "darwin", url: "http://192.168.1.40:4371" };

const saved = {
  data: process.env.SKLAD_DATA_DIR,
  mode: process.env.SKLAD_DRIVE_MODE,
  mac: process.env.SKLAD_MAC_AGENT_URL,
  win: process.env.SKLAD_WINDOWS_AGENT_URL,
};

afterEach(() => {
  restore("SKLAD_DATA_DIR", saved.data);
  restore("SKLAD_DRIVE_MODE", saved.mode);
  restore("SKLAD_MAC_AGENT_URL", saved.mac);
  restore("SKLAD_WINDOWS_AGENT_URL", saved.win);
});

function restore(name: "SKLAD_DATA_DIR" | "SKLAD_DRIVE_MODE" | "SKLAD_MAC_AGENT_URL" | "SKLAD_WINDOWS_AGENT_URL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("mac drive-agent URL", () => {
  it("uses the host loopback when the variable is unset", () => {
    delete process.env.SKLAD_MAC_AGENT_URL;
    expect(macDriveAgentUrl()).toBe(HOST_MAC_DRIVE_AGENT_URL);
    expect(defaultAgentConfig().agents.find((agent) => agent.id === "mac-mini")?.url).toBe("http://127.0.0.1:4371");
  });

  it("uses host.docker.internal when the panel runs in Docker", () => {
    process.env.SKLAD_MAC_AGENT_URL = DOCKER_MAC_DRIVE_AGENT_URL;
    expect(macDriveAgentUrl()).toBe("http://host.docker.internal:4371");
    expect(defaultAgentConfig().agents.find((agent) => agent.id === "mac-mini")?.url).toBe(DOCKER_MAC_DRIVE_AGENT_URL);
    expect(defaultAgentConfig().agents.find((agent) => agent.id === "windows-pc")?.url).toBe("http://127.0.0.1:4372");
  });

  it("replaces a saved loopback Mac agent and leaves Windows and another Mac", () => {
    const agents = applyMacDriveAgentUrl(
      [
        mac,
        windows,
        otherMac,
        { id: "stale", name: "Старый", os: "darwin", url: "http://localhost:4371" },
      ],
      { SKLAD_MAC_AGENT_URL: "http://host.docker.internal:4371" },
    );
    expect(agents.find((agent) => agent.id === "mac-mini")?.url).toBe("http://host.docker.internal:4371");
    expect(agents.find((agent) => agent.id === "stale")?.url).toBe("http://host.docker.internal:4371");
    expect(agents.find((agent) => agent.id === "windows-pc")?.url).toBe("http://127.0.0.1:4372");
    expect(agents.find((agent) => agent.id === "other-mac")?.url).toBe("http://192.168.1.40:4371");
  });

  it("keeps a saved Mac URL when the variable is unset", () => {
    const agents = applyMacDriveAgentUrl([{ ...mac, url: "http://10.0.0.8:4371" }], {});
    expect(agents[0]?.url).toBe("http://10.0.0.8:4371");
  });

  it("reads the Docker URL from drive-agents.json when the variable is set", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sklad-agent-url-"));
    process.env.SKLAD_DATA_DIR = directory;
    process.env.SKLAD_DRIVE_MODE = "agents";
    process.env.SKLAD_MAC_AGENT_URL = DOCKER_MAC_DRIVE_AGENT_URL;
    await writeFile(
      path.join(directory, "drive-agents.json"),
      JSON.stringify({ mode: "mock", agents: [mac, windows, otherMac] }),
    );
    try {
      const config = await readAgentConfig();
      expect(config.mode).toBe("agents");
      expect(config.agents.find((agent) => agent.id === "mac-mini")?.url).toBe("http://host.docker.internal:4371");
      expect(config.agents.find((agent) => agent.id === "windows-pc")?.url).toBe("http://127.0.0.1:4372");
      expect(config.agents.find((agent) => agent.id === "other-mac")?.url).toBe("http://192.168.1.40:4371");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
