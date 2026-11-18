import { describe, expect, it } from "vitest";

import { schedulerStayAwake } from "@/lib/scheduler/apply";

describe("scheduler idle", () => {
  it("stays asleep for seeds and wakes for an active or queued download", () => {
    const seed = { state: "seeding" as const, rawState: "uploading", progress: 1 };
    const active = { state: "downloading" as const, rawState: "downloading", progress: 0.4 };
    const queued = { state: "queued" as const, rawState: "queuedDL", progress: 0 };
    expect(schedulerStayAwake({ plan: { pause: [], resume: [] }, dashboard: { torrents: [seed] } })).toBe(false);
    expect(schedulerStayAwake({ plan: { pause: [], resume: [] }, dashboard: { torrents: [active] } })).toBe(true);
    expect(schedulerStayAwake({ plan: { pause: [], resume: [] }, dashboard: { torrents: [queued] } })).toBe(true);
    expect(schedulerStayAwake({ plan: { pause: ["hash"], resume: [] }, dashboard: { torrents: [] } })).toBe(true);
  });
});
