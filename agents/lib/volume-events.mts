import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import { parseFsEventLine } from "../../src/addons/drives/fsevents-line.ts";
import type { VolumeWatch } from "../../src/addons/drives/index-mode.ts";
import { WINDOWS_VOLUME_EVENT_SCRIPT } from "../../src/addons/drives/win-script.ts";
import { describeMacMount, forgetMacMount } from "../mac-agent/mount.mts";

const macRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mac-agent");
const fsEventsHelper = path.join(macRoot, "fsevents.swift");
const diskArbHelper = path.join(macRoot, "diskarb.swift");

/** Windows: Win32_VolumeChangeEvent. Mac: FSEvents on /Volumes. Other systems: no watcher. */
export function openVolumeWatch(platform: NodeJS.Platform): VolumeWatch | null {
  if (platform === "win32") return windowsVolumeWatch();
  if (platform === "darwin") return macVolumeWatch();
  return null;
}

function windowsVolumeWatch(): VolumeWatch {
  let child: ReturnType<typeof spawn> | null = null;
  return {
    start(onEvent) {
      const request = { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOLUME_EVENT_SCRIPT] };
      assertSpawnAllowed(request);
      child = spawn(request.bin, request.args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const output = child.stdout;
      if (!output) return;
      const lines = createInterface({ input: output });
      lines.on("line", (line) => {
        try {
          const body = JSON.parse(line) as { type?: string; drive?: string };
          const letter = String(body.drive || "").replace(":", "").slice(0, 1).toUpperCase();
          const type = body.type === "detach" ? "detach" : body.type === "attach" ? "attach" : "journal";
          onEvent({ type, letter: /^[A-Z]$/.test(letter) ? letter : null });
        } catch {
          // A broken line is not a volume event.
        }
      });
    },
    stop() {
      child?.kill();
      child = null;
    },
  };
}

/** DiskArbitration JSON line. A path outside /Volumes, or one with .., is ignored. */
export function parseDiskArbLine(line: string): { type: "attach" | "detach"; mount: string } | null {
  let body: { type?: unknown; mount?: unknown };
  try {
    body = JSON.parse(line) as { type?: unknown; mount?: unknown };
  } catch {
    return null;
  }
  const mount = typeof body.mount === "string" ? body.mount : "";
  if (!mount.startsWith("/Volumes/") || mount.includes("\0") || mount.split("/").includes("..")) return null;
  if (body.type !== "attach" && body.type !== "detach") return null;
  return { type: body.type, mount };
}

function macVolumeWatch(): VolumeWatch {
  const stops: Array<() => void> = [];
  return {
    start(onEvent) {
      stops.push(spawnSwift(diskArbHelper, [], (line) => {
        const parsed = parseDiskArbLine(line);
        if (!parsed) return;
        if (parsed.type === "detach") {
          forgetMacMount(parsed.mount);
          onEvent({ type: "detach", mount: parsed.mount });
          return;
        }
        void describeMacMount(parsed.mount).finally(() => onEvent({ type: "attach", mount: parsed.mount }));
      }));
      stops.push(spawnSwift(fsEventsHelper, ["/Volumes"], (line) => {
        const parsed = parseFsEventLine(line);
        if (!parsed) return;
        if (parsed.lost) onEvent({ type: "journal-lost", mount: parsed.path, cursor: parsed.cursor });
        else if (parsed.path) onEvent({ type: "journal", mount: parsed.path, cursor: parsed.cursor });
        else if (parsed.cursor) onEvent({ type: "cursor", cursor: parsed.cursor, mount: "/Volumes" });
      }));
    },
    stop() {
      for (const stop of stops) stop();
      stops.length = 0;
    },
  };
}

function spawnSwift(script: string, args: string[], onLine: (line: string) => void): () => void {
  try {
    const child = spawn("swift", [script, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    const output = child.stdout;
    if (output) {
      const lines = createInterface({ input: output });
      lines.on("line", onLine);
    }
    return () => {
      child.kill();
    };
  } catch {
    return () => undefined;
  }
}
