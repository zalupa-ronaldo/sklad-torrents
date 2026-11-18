import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCKER_MAC_DRIVE_AGENT_URL } from "@/addons/drives/agent-url";
import { channelPullUrl } from "@/lib/service/channel";

const root = process.cwd();

function text(name: string): string {
  return readFileSync(path.join(root, name), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

function serviceNames(yaml: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of yaml.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^[^\s#]/.test(line)) break;
    const match = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("panel container", () => {
  const compose = text("compose.yaml");
  const dockerfile = text("Dockerfile");
  const ignore = text(".dockerignore");

  it("publishes only the panel on loopback 4317 for linux/arm64", () => {
    expect(serviceNames(compose)).toEqual(["panel"]);
    expect(compose).toContain("platform: linux/arm64");
    expect(compose).toContain("127.0.0.1:4317:4317");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain(`SKLAD_MAC_AGENT_URL: ${DOCKER_MAC_DRIVE_AGENT_URL}`);
    expect(compose).toContain("SKLAD_PC_AGENT_URL: http://192.168.0.16:4730");
    expect(compose).toContain("SKLAD_DRIVE_MODE: agents");
    expect(compose).toContain('SKLAD_REAL_ONLY: "1"');
    expect(compose).toContain("SKLAD_DATA_DIR: /Users/uzer/.local/sklad-data-clean");
    expect(compose).toContain("/Users/uzer/.local/sklad-data-clean:/Users/uzer/.local/sklad-data-clean");
    expect(compose).toContain("internal: false");
    expect(compose).toContain("host.docker.internal:host-gateway");
    expect(channelPullUrl({ ...process.env, SKLAD_PC_AGENT_URL: "http://192.168.0.16:4730" })).toBe(
      "http://192.168.0.16:4730/v1/channel",
    );
    const ports = compose.split("ports:")[1]?.split("extra_hosts:")[0] ?? "";
    expect(ports).toContain("127.0.0.1:4317:4317");
    expect(ports).not.toMatch(/8080|18080|4730|4371/);
    expect(compose).not.toMatch(/type:\s*volume/);
    expect(compose).not.toMatch(/\/Volumes/);
    expect(compose).not.toMatch(/drive\.mts/);
    expect(compose).not.toMatch(/env_file/);
    expect(compose).not.toMatch(/\.env/);
  });

  it("does not copy the drive-agent, secrets, or /Volumes into the image", () => {
    expect(dockerfile).toContain("--platform=linux/arm64");
    expect(dockerfile).toContain("NODE_OPTIONS=--max-old-space-size=768");
    expect(dockerfile).toContain("tsconfig.docker.json");
    expect(dockerfile).toContain("EXPOSE 4317");
    expect(dockerfile).not.toMatch(/drive\.mts/);
    expect(dockerfile).not.toMatch(/\/Volumes/);
    expect(dockerfile).not.toMatch(/\.env/);
    expect(dockerfile).not.toMatch(/COPY[^\n]*(agents\/mac-agent|agents\/pc-agent)/);
    for (const excluded of [
      ".env",
      ".env.*",
      "data",
      "*.pem",
      "*.key",
      "agents/mac-agent/drive.mts",
      "agents/mac-agent/collect.mts",
    ]) {
      expect(ignore).toContain(excluded);
    }
    const events = readFileSync(path.join(root, "agents/lib/volume-events.mts"), "utf8");
    expect(events).not.toContain("mac-agent/collect.mts");
    expect(events).toContain("mac-agent/mount.mts");
    expect(events).not.toContain("fs.watch");
    const workflow = readFileSync(path.join(root, ".github/workflows/windows-emulation.yml"), "utf8");
    expect(workflow).toContain("docker build");
  });
});
