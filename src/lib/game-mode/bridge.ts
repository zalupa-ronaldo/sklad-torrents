import { holdFilePath, readHoldHashes, writeHoldHashes } from "@/lib/game-mode/hold-file";
import { publishGameMode, readGameMode, resetGameModeForTests } from "@/lib/game-mode/hub";
import { dataDir } from "@/lib/qbittorrent/store";
import { agentGameUrl, parseGameMode } from "@/lib/game-mode/remote";
import { emptyHold, type GameModeName, type GameModeView, type HoldState } from "@/lib/game-mode/session";
import { syncWindowsTorrents } from "@/lib/game-mode/torrents";

export interface TorrentDeps {
  downloading(): Promise<string[]>;
  pause(hash: string): Promise<unknown>;
  resume(hash: string): Promise<unknown>;
}

interface BridgeState {
  active: boolean;
  held: string[];
  hold: HoldState;
  chain: Promise<void>;
}

function bridge(): BridgeState {
  const g = globalThis as typeof globalThis & { __skladGameBridgeState?: BridgeState };
  if (!g.__skladGameBridgeState) {
    g.__skladGameBridgeState = { active: false, held: [], hold: emptyHold(), chain: Promise.resolve() };
  }
  return g.__skladGameBridgeState;
}

export function resetGameBridgeForTests(): void {
  const g = globalThis as typeof globalThis & { __skladGameBridgeState?: BridgeState; __skladGameBridge?: boolean };
  delete g.__skladGameBridgeState;
  delete g.__skladGameBridge;
  resetGameModeForTests();
}

function workCounts(body: Partial<GameModeView>): { encode: number; nsz: number; compact: number } {
  const paused = body.paused;
  return {
    encode: paused && Number.isInteger(paused.encode) ? paused.encode : 0,
    nsz: paused && Number.isInteger(paused.nsz) ? paused.nsz : 0,
    compact: paused && Number.isInteger(paused.compact) ? paused.compact : 0,
  };
}

function viewFromRemote(body: unknown): { hold: HoldState; work: { encode: number; nsz: number; compact: number } } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Partial<GameModeView> & { mode?: GameModeName };
  if (record.mode !== "auto" && record.mode !== "on" && record.mode !== "off") return null;
  const hold: HoldState = {
    ...emptyHold(),
    mode: record.mode,
    active: record.active === true,
    source: record.source === "manual" ? "manual" : "auto",
    game: typeof record.game === "string" ? record.game : null,
    exe: typeof record.exe === "string" ? record.exe : null,
    heldTorrents: [],
  };
  return { hold, work: workCounts(record) };
}

export async function followRemoteGame(body: unknown, deps: TorrentDeps, agent: GameModeView["agent"] = "ok"): Promise<GameModeView> {
  const parsed = viewFromRemote(body);
  if (!parsed) return readGameMode();
  const current = bridge();
  const run = current.chain.then(async () => {
    if (parsed.hold.active === current.active) {
      current.hold = { ...parsed.hold, heldTorrents: current.held };
      publishGameMode(current.hold, agent, parsed.work);
      return;
    }
    const synced = await syncWindowsTorrents(parsed.hold.active, current.held, deps);
    current.active = parsed.hold.active;
    current.held = synced.held;
    current.hold = { ...parsed.hold, heldTorrents: synced.held };
    publishGameMode(current.hold, agent, parsed.work);
    await rememberTorrents(synced.held);
  });
  current.chain = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
  return readGameMode();
}

export async function pushGameMode(
  mode: GameModeName,
  deps: TorrentDeps & {
    post(url: string, body: { mode: GameModeName }): Promise<unknown>;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<GameModeView> {
  const url = agentGameUrl(env, "/v1/game-mode");
  if (!url) {
    const hold = { ...emptyHold(), mode, active: mode === "on", source: mode === "auto" ? "auto" as const : "manual" as const, game: mode === "on" ? "Вручную" : null };
    const synced = await syncWindowsTorrents(hold.active, bridge().held, deps);
    bridge().active = hold.active;
    bridge().held = synced.held;
    bridge().hold = { ...hold, heldTorrents: synced.held };
    await rememberTorrents(synced.held);
    return publishGameMode(bridge().hold, "unreachable");
  }
  try {
    const body = await deps.post(url, { mode });
    return followRemoteGame(body, deps, "ok");
  } catch {
    const hold = { ...emptyHold(), mode, active: mode === "on", source: "manual" as const, game: mode === "on" ? "Вручную" : null };
    const synced = await syncWindowsTorrents(hold.active, bridge().held, deps);
    bridge().active = hold.active;
    bridge().held = synced.held;
    bridge().hold = { ...hold, heldTorrents: synced.held };
    await rememberTorrents(synced.held);
    return publishGameMode(bridge().hold, "unreachable");
  }
}

export function ensureGameModeBridge(env: NodeJS.ProcessEnv = process.env): void {
  if (process.env.VITEST) return;
  const g = globalThis as typeof globalThis & { __skladGameBridge?: boolean };
  if (g.__skladGameBridge) return;
  const url = agentGameUrl(env, "/v1/game-mode/events");
  if (!url) return;
  g.__skladGameBridge = true;
  void connectLoop(url);
}

async function rememberTorrents(hashes: readonly string[]): Promise<void> {
  if (process.env.VITEST) return;
  await writeHoldHashes(holdFilePath(dataDir()), hashes).catch(() => undefined);
}

async function connectLoop(url: string): Promise<void> {
  const { productionTorrentDeps } = await import("@/lib/game-mode/production");
  const deps = productionTorrentDeps();
  const saved = await readHoldHashes(holdFilePath(dataDir())).catch(() => [] as string[]);
  if (saved.length > 0) {
    const current = bridge();
    current.held = saved;
    current.active = true;
  }
  let resumedAfterFailure = false;
  for (;;) {
    try {
      await readEventStream(url, (body) => {
        void followRemoteGame(body, deps).catch(() => undefined);
      });
    } catch {
      // One resume if the agent never answers, so a restart cannot leave downloads paused.
      if (!resumedAfterFailure && bridge().held.length > 0) {
        resumedAfterFailure = true;
        try {
          const synced = await syncWindowsTorrents(false, bridge().held, deps);
          bridge().held = synced.held;
          bridge().active = false;
          await rememberTorrents([]);
        } catch {
          // The Web UI did not answer. The hashes stay on disk for the next start.
        }
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }
}

async function readEventStream(url: string, onData: (body: unknown) => void): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw new Error("Агент ПК не ответил.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data.startsWith(":")) continue;
      try {
        onData(JSON.parse(data) as unknown);
      } catch {
        // A broken event is not a mode change.
      }
    }
  }
}

export function assertMode(body: unknown): GameModeName {
  const mode = parseGameMode(body);
  if (!mode) throw new Error("Нужен режим on, off или auto.");
  return mode;
}
