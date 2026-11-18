import { emptyHold, gameView, type GameModeView, type HoldState } from "@/lib/game-mode/session";

type Listener = (view: GameModeView) => void;

const state = {
  hold: emptyHold() as HoldState,
  agent: "unreachable" as GameModeView["agent"],
  work: { encode: 0, nsz: 0, compact: 0 },
  listeners: new Set<Listener>(),
};

export function readGameMode(): GameModeView {
  const view = gameView(state.hold, state.agent);
  view.paused.encode = state.work.encode;
  view.paused.nsz = state.work.nsz;
  view.paused.compact = state.work.compact;
  view.paused.torrents = state.hold.heldTorrents.length;
  view.steamTouched = false;
  return view;
}

export function publishGameMode(
  hold: HoldState,
  agent?: GameModeView["agent"],
  work?: { encode: number; nsz: number; compact: number },
): GameModeView {
  state.hold = hold;
  if (agent) state.agent = agent;
  if (work) state.work = { encode: count(work.encode), nsz: count(work.nsz), compact: count(work.compact) };
  const view = readGameMode();
  for (const listener of state.listeners) listener(view);
  return view;
}

function count(value: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

export function subscribeGameMode(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function resetGameModeForTests(): void {
  state.hold = emptyHold();
  state.agent = "unreachable";
  state.work = { encode: 0, nsz: 0, compact: 0 };
  state.listeners.clear();
}
