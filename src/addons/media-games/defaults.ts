import type { ToolHostConfig, ToolsConfig } from "@/addons/media-games/types";

/** Starting paths the owner edits in Настройки. Nothing here is treated as installed. */
export function defaultToolsConfig(): ToolsConfig {
  return {
    demoMode: true,
    hosts: [defaultMacHost(), defaultPcHost()],
  };
}

export function defaultMacHost(): ToolHostConfig {
  return {
    id: "mac-local",
    name: "Mac mini",
    os: "darwin",
    agentUrl: null,
    handbrakePath: "/usr/local/bin/HandBrakeCLI",
    handbrakeExtra: "/opt/homebrew/bin/HandBrakeCLI",
    compactPath: "",
    compactGuiPath: "",
    libraryFolders: ["/Users/me/Games", "/Volumes/vault/Games"],
  };
}

export function defaultPcHost(): ToolHostConfig {
  return {
    id: "pc-agent",
    name: "Windows PC",
    os: "win32",
    agentUrl: "http://127.0.0.1:4730",
    handbrakePath: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
    handbrakeExtra: "",
    compactPath: "C:\\Windows\\System32\\compact.exe",
    compactGuiPath: "C:\\Program Files\\CompactGUI\\CompactGUI.exe",
    libraryFolders: ["D:\\Games", "C:\\Games"],
  };
}
