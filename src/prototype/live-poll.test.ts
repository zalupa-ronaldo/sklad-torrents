import { describe, expect, it } from "vitest";

import { confirmSpec, FAST_POLL_MS, flattenShelfGames, HEAVY_POLL_MS, pollPlan, sectionDue, sseDue, SSE_COALESCE_MS } from "../../public/prototype/live-poll.js";

describe("live poll", () => {
  it("refreshes jobs every 5 seconds, heavy sections every minute, and skips a hidden tab", () => {
    expect(FAST_POLL_MS).toBe(5_000);
    expect(HEAVY_POLL_MS).toBe(60_000);
    expect(pollPlan({ hidden: false, now: 1, lastFast: 0, lastHeavy: 0, fastBusy: false, heavyBusy: false })).toEqual({ fast: false, heavy: true });
    expect(pollPlan({ hidden: true, now: 1, lastFast: 0, lastHeavy: 0, fastBusy: false, heavyBusy: false })).toEqual({ fast: false, heavy: false });
    expect(pollPlan({ hidden: false, now: 6_000, lastFast: 0, lastHeavy: 1, fastBusy: false, heavyBusy: false })).toEqual({ fast: true, heavy: false });
    expect(pollPlan({ hidden: false, now: 61_000, lastFast: 60_000, lastHeavy: 1, fastBusy: false, heavyBusy: false }).heavy).toBe(true);
    expect(pollPlan({ hidden: false, now: 6_000, lastFast: 0, lastHeavy: 1, fastBusy: true, heavyBusy: false }).fast).toBe(false);
    expect(sectionDue("games")).toBe(true);
    expect(sectionDue("menu")).toBe(false);
  });

  it("coalesces job events to one refresh per 2 seconds", () => {
    expect(SSE_COALESCE_MS).toBe(2_000);
    expect(sseDue({ hidden: false, lastAt: 0, now: 1 })).toBe(true);
    expect(sseDue({ hidden: true, lastAt: 0, now: 1 })).toBe(false);
    expect(sseDue({ hidden: false, lastAt: 1_000, now: 2_000 })).toBe(false);
    expect(sseDue({ hidden: false, lastAt: 1_000, now: 3_000 })).toBe(true);
  });

  it("reads games from platforms and does not invent any", () => {
    expect(flattenShelfGames({ platforms: [{ id: "windows", games: [{ id: "rim", name: "RimWorld", placement: "HDD" }] }] })).toEqual([
      { id: "rim", contentId: "rim", name: "RimWorld", platform: "Windows", placement: "HDD", sizeBytes: null },
    ]);
    expect(flattenShelfGames({ games: [{ name: "Invented" }] })).toEqual([]);
    expect(flattenShelfGames(null)).toEqual([]);
  });

  it("requires a dialog before a destructive action", () => {
    for (const name of ["invReset", "invRemove", "invRemoveTorrent", "pipeDelete", "integrityConfirm", "shopApply", "shopTray", "cancel"]) {
      expect(confirmSpec(name, "jobs")?.label).toBeTruthy();
    }
    expect(confirmSpec("run", "optical")?.title).toMatch(/Записать/);
    expect(confirmSpec("run", "move")).toBeNull();
    expect(confirmSpec("pause", "jobs")).toBeNull();
  });
});
