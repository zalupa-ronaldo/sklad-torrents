import { describe, expect, it } from "vitest";

import { listMockJobs, pauseMockJob, resetMockJobsForTests } from "@/lib/progress/mock-jobs";
import { toJobCard } from "@/lib/progress/view";

describe("demo job engine", () => {
  it("moves HandBrake, compact, copy, and index progress without those tools", () => {
    const origin = 1_700_000_000_000;
    resetMockJobsForTests(origin);
    const early = listMockJobs(origin + 4_000);
    const later = listMockJobs(origin + 14_000);
    for (const id of ["transcode-interstellar", "compact-gow", "copy-control", "index-vault"]) {
      const before = early.find((job) => job.id === id);
      const after = later.find((job) => job.id === id);
      expect(before?.status).toBe("running");
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (!before || !after) return;
      expect(after.processedBytes).toBeGreaterThan(before.processedBytes);
      expect(after.progress).toBeGreaterThan(before.progress);
    }
    const compact = later.find((job) => job.id === "compact-gow");
    expect(compact?.capabilities.pause).toBe(false);
    expect(compact?.pauseUnsupportedReason).toBe("Движок не умеет паузу");
    expect(compact?.capabilities.cancel).toBe(true);
    const handbrake = later.find((job) => job.id === "transcode-interstellar");
    expect(handbrake?.kind).toBe("transcode");
    expect(handbrake?.capabilities.pause).toBe(true);
    const broken = later.find((job) => job.id === "transcode-broken");
    expect(broken?.status).toBe("error");
    expect(broken?.error).toBe("HandBrake не открыл исходник");
    expect(toJobCard(broken!).canPause).toBe(false);
  });

  it("freezes a paused copy and keeps counting after resume", () => {
    const origin = 1_700_000_000_000;
    resetMockJobsForTests(origin);
    const atPause = origin + 10_000;
    expect(pauseMockJob("copy-control", atPause)).toBe(true);
    const paused = listMockJobs(atPause).find((job) => job.id === "copy-control");
    const held = listMockJobs(atPause + 20_000).find((job) => job.id === "copy-control");
    expect(held?.status).toBe("paused");
    expect(held?.processedBytes).toBe(paused?.processedBytes);
    expect(toJobCard(held!).canResume).toBe(true);
    expect(toJobCard(held!).canPause).toBe(false);
  });
});
