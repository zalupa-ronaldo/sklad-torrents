"use strict";

export const LIVE_POLL_MS = 45_000;

export function pollDue({ hidden, inFlight, lastAt, now, interval = LIVE_POLL_MS }) {
  if (hidden || inFlight) return false;
  if (!lastAt) return true;
  return now - lastAt >= interval;
}

globalThis.LivePoll = { LIVE_POLL_MS, pollDue };
