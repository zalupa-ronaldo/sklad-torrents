import { describe, expect, it } from "vitest";

import { LIVE_POLL_MS, pollDue } from "../../public/prototype/live-poll.js";

describe("live poll", () => {
  it("waits 45 seconds and does not poll a hidden tab or an in-flight request", () => {
    expect(LIVE_POLL_MS).toBeGreaterThanOrEqual(30_000);
    expect(LIVE_POLL_MS).toBeLessThanOrEqual(60_000);
    expect(pollDue({ hidden: false, inFlight: false, lastAt: 0, now: 1 })).toBe(true);
    expect(pollDue({ hidden: true, inFlight: false, lastAt: 0, now: 1 })).toBe(false);
    expect(pollDue({ hidden: false, inFlight: true, lastAt: 0, now: 1 })).toBe(false);
    expect(pollDue({ hidden: false, inFlight: false, lastAt: 1_000, now: 20_000 })).toBe(false);
    expect(pollDue({ hidden: false, inFlight: false, lastAt: 1_000, now: 46_000 })).toBe(true);
  });
});
