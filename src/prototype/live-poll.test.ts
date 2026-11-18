import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import { confirmSpec, flattenShelfGames, pollPlan, sectionDue, sseDue, SSE_COALESCE_MS } from "../../public/prototype/live-poll.js";

describe("live poll", () => {
  it("does not poll on a timer; it refreshes on open, navigation, and job events", () => {
    expect(pollPlan({ hidden: false, reason: "idle", now: 999_999 })).toEqual({ fast: false, heavy: false });
    expect(pollPlan({ hidden: true, reason: "open", now: 0 })).toEqual({ fast: false, heavy: false });
    expect(pollPlan({ hidden: false, reason: "open", now: 0 })).toEqual({ fast: false, heavy: true });
    expect(pollPlan({ hidden: false, reason: "navigate", now: 0 })).toEqual({ fast: false, heavy: true });
    expect(pollPlan({ hidden: false, reason: "job", now: 0 })).toEqual({ fast: true, heavy: false });
    expect(sectionDue("games")).toBe(true);
    expect(sectionDue("menu")).toBe(false);
    const app = readFileSync(path.join(process.cwd(), "public/prototype/app.js"), "utf8");
    expect(app).not.toMatch(/setInterval\(\s*tick/);
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
    expect(flattenShelfGames({ showingSamples: true, platforms: [{ id: "windows", games: [{ id: "sample", name: "Sample Game" }] }] })).toEqual([]);
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
