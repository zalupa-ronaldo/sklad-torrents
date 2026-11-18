import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectGame } from "@/lib/game-mode/detect";
import { followRemoteGame, pushGameMode, resetGameBridgeForTests } from "@/lib/game-mode/bridge";
import { gameRoot, parseAppManifest, parseLibraryFolders, steamLibraryEntries } from "@/lib/game-mode/library";
import { agentGameUrl, parseGameMode } from "@/lib/game-mode/remote";
import { applyEffects, continueArgv, emptyHold, gameView, nextHeldPids, reduceGame, startupRecovery, suspendArgv } from "@/lib/game-mode/session";
import { isSteamProcess } from "@/lib/game-mode/steam";
import { selectDownloadHashes, syncWindowsTorrents } from "@/lib/game-mode/torrents";
import { consumeWatchLine, createGameService } from "../../../agents/pc-agent/game-mode.mjs";

const HASH = "a".repeat(40);
const HADES = "b".repeat(40);

const library = [{ name: "Hades", exe: "Hades.exe", source: "sklad" as const }];

function input(extra: Partial<Parameters<typeof reduceGame>[1]> = {}) {
  return {
    processes: [],
    library,
    jobs: [],
    downloads: [],
    ...extra,
  };
}

describe("game mode", () => {
  afterEach(() => {
    resetGameBridgeForTests();
  });

  it("does not treat SteamWorld or the Steam client as the same thing", () => {
    expect(isSteamProcess("steamwebhelper.exe")).toBe(true);
    expect(isSteamProcess("C:\\Program Files\\Steam\\steam.exe")).toBe(true);
    expect(isSteamProcess("SteamWorldDig.exe")).toBe(false);
  });

  it("pauses work and downloads when a library game starts, and never Steam", () => {
    const next = reduceGame(
      emptyHold(),
      input({
        processes: [
          { pid: 10, name: "steamwebhelper.exe" },
          { pid: 11, name: "Hades.exe", exePath: "D:\\Games\\Hades\\Hades.exe" },
          { pid: 12, name: "HandBrakeCLI.exe" },
          { pid: 13, name: "nsz.exe" },
          { pid: 14, name: "CompactGUI.exe" },
        ],
        jobs: [
          { id: "enc", kind: "transcode", pid: 12 },
          { id: "user", kind: "compress", pid: 99, userPaused: true },
        ],
        downloads: [{ hash: HASH }, { hash: "nope" }, { hash: HADES }],
      }),
    );
    expect(next.state.active).toBe(true);
    expect(next.state.game).toBe("Hades");
    expect(next.state.held.map((item) => item.pid)).toEqual([12, 13, 14]);
    expect(next.state.heldJobs).toEqual(["enc"]);
    expect(next.state.heldTorrents).toEqual([HASH, HADES]);
    expect(next.effects.some((effect) => "pid" in effect && effect.pid === 10)).toBe(false);
    expect(next.effects.some((effect) => effect.op === "suspend" && effect.kind === "encode")).toBe(true);
    const again = reduceGame(next.state, input({ processes: [{ pid: 11, name: "Hades.exe" }] }));
    expect(again.effects).toEqual([]);
    const stopped = reduceGame(next.state, input());
    expect(stopped.state.active).toBe(false);
    expect(stopped.state.held).toEqual([]);
    expect(stopped.effects.map((effect) => effect.op)).toEqual(["queue-resume", "continue", "continue", "continue", "torrent-resume", "torrent-resume"]);
  });

  it("keeps a manual off while a game is running and a manual on with no process", () => {
    const playing = reduceGame(emptyHold(), input({ processes: [{ pid: 4, name: "Hades.exe" }] }));
    const off = reduceGame(playing.state, input({ mode: "off", processes: [{ pid: 4, name: "Hades.exe" }] }));
    expect(off.state.active).toBe(false);
    expect(off.effects[0]).toEqual({ op: "queue-resume" });
    const on = reduceGame(emptyHold(), input({ mode: "on" }));
    expect(on.state).toMatchObject({ active: true, game: "Вручную", source: "manual" });
    expect(gameView(on.state).steamTouched).toBe(false);
  });

  it("matches a Steam install directory and a fullscreen GPU app, not a browser", () => {
    expect(
      detectGame(
        [{ pid: 3, name: "Hades.exe", exePath: "D:\\SteamLibrary\\steamapps\\common\\Hades\\Hades.exe" }],
        [{ name: "Hades", root: "D:\\SteamLibrary\\steamapps\\common\\Hades", source: "steam" }],
      )?.via,
    ).toBe("library");
    expect(detectGame([{ pid: 8, name: "Celeste.exe", fullscreen: true, gpu: true }], [])).toMatchObject({ via: "fullscreen" });
    expect(detectGame([{ pid: 8, name: "Celeste.exe", fullscreen: true, gpu: false }], [])).toBeNull();
    expect(detectGame([{ pid: 8, name: "chrome.exe", fullscreen: true, gpu: true }], [])).toBeNull();
    expect(detectGame([{ pid: 8, name: "steam.exe", fullscreen: true, gpu: true }], [])).toBeNull();
    expect(detectGame([{ pid: 0, name: "Celeste.exe", fullscreen: true, gpu: true }], [])).toBeNull();
    expect(detectGame([{ pid: 2, name: "Hades.exe", exePath: "D:\\Steam\\..\\Hades.exe" }], [{ name: "Hades", root: "D:\\Steam", source: "steam" }])).toBeNull();
  });

  it("suspends and continues without kill, and refuses a Steam pid at apply time", async () => {
    const stop = suspendArgv(12, "linux");
    const cont = continueArgv(12, "win32");
    expect(stop).toEqual({ bin: "kill", args: ["-STOP", "12"] });
    expect(cont).toEqual({
      bin: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Resume-Process -Id 12 -ErrorAction Stop"],
    });
    expect(JSON.stringify(stop)).not.toMatch(/KILL|taskkill|Stop-Process/);
    expect(suspendArgv(0, "win32")).toEqual({ error: "Некорректный pid." });
    const seen: string[] = [];
    await applyEffects([{ op: "queue-pause" }, { op: "suspend", pid: 12, kind: "encode" }, { op: "torrent-pause", hash: HASH }], {
      suspend: async (pid) => seen.push(`stop ${pid}`),
      resume: async () => undefined,
      pauseQueue: () => seen.push("queue"),
      resumeQueue: () => undefined,
      pauseTorrent: async (hash) => seen.push(hash),
      resumeTorrent: async () => undefined,
    });
    expect(seen).toEqual(["queue", "stop 12", HASH]);
    await expect(
      applyEffects([{ op: "suspend", pid: 10, kind: "encode" }], {
        suspend: async () => undefined,
        resume: async () => undefined,
        pauseQueue: () => undefined,
        resumeQueue: () => undefined,
        pauseTorrent: async () => undefined,
        resumeTorrent: async () => undefined,
        isSteamPid: () => true,
      }),
    ).rejects.toThrow(/Steam/);
  });

  it("reads a Steam library folder list without walking upward", () => {
    const folders = parseLibraryFolders('"path" "D:\\\\SteamLibrary"\n"path" "C:\\\\..\\\\Windows"');
    expect(folders).toEqual(["D:\\SteamLibrary"]);
    expect(parseAppManifest('"name" "Hades"\n"installdir" "Hades"')).toEqual({ name: "Hades", installdir: "Hades" });
    expect(parseAppManifest('"name" "Bad"\n"installdir" "a/b"')).toBeNull();
    expect(gameRoot("D:\\SteamLibrary", "Hades")).toBe("D:\\SteamLibrary\\steamapps\\common\\Hades");
    expect(steamLibraryEntries(folders, [{ folder: "D:\\SteamLibrary", text: '"name" "Hades"\n"installdir" "Hades"' }])).toEqual([
      { name: "Hades", root: "D:\\SteamLibrary\\steamapps\\common\\Hades", source: "steam" },
    ]);
  });

  it("pauses only Windows downloads and resumes just those hashes", async () => {
    expect(
      selectDownloadHashes([
        { hash: HASH, hostOs: "win32", state: "downloading", rawState: "downloading", progress: 0.2 },
        { hash: HADES, hostOs: "darwin", state: "downloading", rawState: "downloading", progress: 0.2 },
        { hash: "c".repeat(40), hostOs: "win32", state: "seeding", rawState: "uploading", progress: 1 },
        { hash: "d".repeat(40), hostOs: "win32", state: "queued", rawState: "queuedDL", progress: 0 },
      ]),
    ).toEqual([HASH, "d".repeat(40)]);
    const paused: string[] = [];
    const resumed: string[] = [];
    const first = await syncWindowsTorrents(true, [], {
      downloading: async () => [HASH],
      pause: async (hash) => paused.push(hash),
      resume: async (hash) => resumed.push(hash),
    });
    const second = await syncWindowsTorrents(true, first.held, {
      downloading: async () => [HASH],
      pause: async (hash) => paused.push(hash),
      resume: async () => undefined,
    });
    expect(second.paused).toEqual([]);
    const done = await syncWindowsTorrents(false, second.held, {
      downloading: async () => [],
      pause: async () => undefined,
      resume: async (hash) => resumed.push(hash),
    });
    expect(paused).toEqual([HASH]);
    expect(resumed).toEqual([HASH]);
    expect(done.held).toEqual([]);
  });

  it("follows an agent event once and ignores a broken body", async () => {
    const paused: string[] = [];
    const deps = {
      downloading: async () => [HASH],
      pause: async (hash: string) => paused.push(hash),
      resume: async () => undefined,
    };
    const view = await followRemoteGame(
      { active: true, mode: "auto", source: "auto", game: "Hades", exe: "hades.exe", paused: { torrents: 0, encode: 1, nsz: 1, compact: 0 }, steamTouched: true },
      deps,
    );
    expect(view.active).toBe(true);
    expect(view.paused).toMatchObject({ torrents: 1, encode: 1, nsz: 1 });
    expect(view.steamTouched).toBe(false);
    await followRemoteGame({ active: true, mode: "auto", game: "Hades" }, deps);
    expect(paused).toEqual([HASH]);
    expect(await followRemoteGame({ mode: "sideways" }, deps)).toMatchObject({ active: true });
    const off = await followRemoteGame({ active: false, mode: "auto", game: null }, deps);
    expect(off.active).toBe(false);
    expect(off.paused.torrents).toBe(0);
  });

  it("posts the manual switch and still pauses when the agent has no URL", async () => {
    const env = (value: string): NodeJS.ProcessEnv => ({ ...process.env, SKLAD_PC_AGENT_URL: value });
    expect(agentGameUrl(env("http://192.168.0.16:4730"), "/v1/game-mode")).toBe("http://192.168.0.16:4730/v1/game-mode");
    expect(agentGameUrl(env("file:///tmp/x"), "/v1/game-mode")).toBeNull();
    expect(agentGameUrl(env("http://user:secret@127.0.0.1:4730"), "/v1/game-mode")).toBeNull();
    expect(parseGameMode({ mode: "auto" })).toBe("auto");
    expect(parseGameMode({ mode: "later" })).toBeNull();
    const paused: string[] = [];
    const view = await pushGameMode("on", {
      downloading: async () => [HASH],
      pause: async (hash) => paused.push(hash),
      resume: async () => undefined,
      post: async () => {
        throw new Error("нет");
      },
    }, { ...process.env, SKLAD_PC_AGENT_URL: undefined });
    expect(view.agent).toBe("unreachable");
    expect(view.active).toBe(true);
    expect(paused).toEqual([HASH]);
    const posted: unknown[] = [];
    const remote = await pushGameMode("off", {
      downloading: async () => [],
      pause: async () => undefined,
      resume: async () => undefined,
      post: async (_url, body) => {
        posted.push(body);
        return { active: false, mode: "off", source: "manual", game: null };
      },
    }, env("http://192.168.0.16:4730"));
    expect(posted).toEqual([{ mode: "off" }]);
    expect(remote.active).toBe(false);
  });

  it("continues saved pids and torrents after a restart and never a Steam pid", () => {
    const effects = startupRecovery(
      { pids: [12, 10, 0], torrents: [HASH, "nope"] },
      [{ pid: 10, name: "steam.exe" }],
    );
    expect(effects).toEqual([
      { op: "continue", pid: 12 },
      { op: "torrent-resume", hash: HASH },
    ]);
    expect(nextHeldPids([12], effects)).toEqual([]);
    expect(nextHeldPids([], [{ op: "suspend", pid: 12, kind: "encode" }])).toEqual([12]);
  });

  it("keeps the agent service in mock from suspending and updates on a watch line", async () => {
    const suspended: number[] = [];
    const service = createGameService({
      empty: emptyHold,
      reduce: reduceGame,
      viewOf: (state: ReturnType<typeof emptyHold>) => gameView(state, "mock"),
      mock: true,
      jobs: () => [{ id: "enc", kind: "transcode", pid: 12, userPaused: false }],
      apply: async () => suspended.push(1),
    });
    await consumeWatchLine(service, JSON.stringify({ type: "start", pid: 4, name: "Hades.exe" }));
    await service.setLibrary([{ name: "Hades", exe: "Hades.exe", source: "sklad" }]);
    const view = await service.sync({ processes: [{ pid: 4, name: "Hades.exe" }] });
    expect(view.active).toBe(true);
    expect(suspended).toEqual([]);
    const script = readFileSync(path.join(process.cwd(), "agents/pc-agent/game-watch.ps1"), "utf8");
    expect(script).not.toMatch(/Stop-Process|taskkill|Remove-Item|SIGKILL/);
    expect(script).toMatch(/Win32_ProcessStartTrace/);
    expect(script).toMatch(/Wait-Event/);
  });
});
