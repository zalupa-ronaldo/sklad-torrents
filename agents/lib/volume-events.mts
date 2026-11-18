import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import { parseFsEventLine } from "../../src/addons/drives/fsevents-line.ts";
import type { VolumeWatch, VolumeWatchEvent } from "../../src/addons/drives/index-mode.ts";
import { WINDOWS_VOLUME_EVENT_SCRIPT } from "../../src/addons/drives/win-script.ts";
import { describeMacMount, forgetMacMount } from "../mac-agent/collect.mts";

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mac-agent", "fsevents.swift");

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

function macVolumeWatch(): VolumeWatch {
  const stops: Array<() => void> = [];
  return {
    start(onEvent) {
      void watchVolumes(onEvent, stops);
    },
    stop() {
      for (const stop of stops) stop();
      stops.length = 0;
    },
  };
}

async function watchVolumes(onEvent: (event: VolumeWatchEvent) => void, stops: Array<() => void>) {
  const seen = new Set<string>();
  const note = async (name: string) => {
    if (!name || name.startsWith(".") || seen.has(name)) return;
    seen.add(name);
    const mount = path.join("/Volumes", name);
    await describeMacMount(mount);
    onEvent({ type: "attach", mount });
    try {
      const watcher = watch(mount, { recursive: true }, (_kind, filename) => {
        const relative = String(filename || "").replace(/\\/g, "/");
        if (!relative || relative.includes("..")) return;
        onEvent({
          type: "journal",
          mount,
          delta: {
            upserts: [{ relativePath: relative, name: path.posix.basename(relative), kind: "file", size: null, mtimeMs: Date.now() }],
            deletes: [],
            complete: true,
          },
        });
      });
      stops.push(() => watcher.close());
    } catch {
      // A volume that cannot be watched still keeps the one catalog built on attach.
    }
  };
  const names = await readdir("/Volumes").catch(() => [] as string[]);
  for (const name of names) await note(name);
  try {
    const root = watch("/Volumes", (_kind, filename) => {
      const name = String(filename || "");
      if (!name) return;
      void note(name).catch(() => {
        seen.delete(name);
        forgetMacMount(path.join("/Volumes", name));
        onEvent({ type: "detach", mount: path.join("/Volumes", name) });
      });
    });
    stops.push(() => root.close());
  } catch {
    // /Volumes is missing. There is nothing to watch.
  }
  const request = { bin: "swift", args: [helper, "/Volumes"] };
  try {
    const child = spawn(request.bin, request.args, { stdio: ["ignore", "pipe", "ignore"] });
    stops.push(() => child.kill());
    const output = child.stdout;
    if (!output) return;
    const lines = createInterface({ input: output });
    lines.on("line", (line) => {
      const parsed = parseFsEventLine(line);
      if (!parsed) return;
      if (parsed.lost) onEvent({ type: "journal-lost", mount: parsed.path, cursor: parsed.cursor });
      else if (parsed.path) onEvent({ type: "journal", mount: parsed.path, cursor: parsed.cursor });
      else if (parsed.cursor) onEvent({ type: "cursor", cursor: parsed.cursor, mount: "/Volumes" });
    });
  } catch {
    // Without the helper, live FSEvents from fs.watch still report new files. A restart does not invent a cursor.
  }
}
