import { describe, expect, it } from "vitest";

import { decideAdmission, hourInSchedule, shouldSuspendRunning } from "@/lib/optical/admission";
import { sha256, sourceDigest } from "@/lib/optical/checksum";
import { isForbiddenVolumePath } from "@/lib/optical/paths";
import { bytesPerSecond, etaSeconds } from "@/lib/optical/progress-math";
import { normalizeCatalog } from "@/lib/optical/drive-catalog";

describe("optical admission", () => {
  const open = { queuePaused: false, disturb: false, maxParallel: 1, running: 0, withinSchedule: true };

  it("starts when the queue, the schedule, and the slot are free", () => {
    expect(decideAdmission(open)).toEqual({ start: true, reason: null });
  });

  it("refuses a paused queue, disturb mode, a closed schedule, and a full slot", () => {
    expect(decideAdmission({ ...open, queuePaused: true }).reason).toBe("queue");
    expect(decideAdmission({ ...open, disturb: true }).reason).toBe("disturb");
    expect(decideAdmission({ ...open, withinSchedule: false }).reason).toBe("schedule");
    expect(decideAdmission({ ...open, running: 1 }).reason).toBe("parallel");
    expect(decideAdmission({ ...open, maxParallel: 0 }).reason).toBe("parallel");
  });

  it("suspends a running burn for the queue, not for a full parallel slot", () => {
    expect(shouldSuspendRunning(decideAdmission({ ...open, queuePaused: true }))).toBe(true);
    expect(shouldSuspendRunning(decideAdmission({ ...open, running: 1 }))).toBe(false);
  });

  it("treats a same-hour window as the whole day and wraps past midnight", () => {
    expect(hourInSchedule(3, { startHour: 9, endHour: 9 })).toBe(true);
    expect(hourInSchedule(23, { startHour: 22, endHour: 6 })).toBe(true);
    expect(hourInSchedule(12, { startHour: 22, endHour: 6 })).toBe(false);
    expect(hourInSchedule(12, null)).toBe(true);
  });
});

describe("optical paths and checksum", () => {
  it("recognises the forbidden volume and does not read it", async () => {
    expect(isForbiddenVolumePath("Z:\\Films\\a.iso")).toBe(true);
    expect(isForbiddenVolumePath("/mnt/z/Films")).toBe(true);
    expect(isForbiddenVolumePath("D:\\Films\\a.iso")).toBe(false);
    const read = () => Promise.reject(new Error("read"));
    await expect(sourceDigest([{ path: "Z:\\Films\\a.iso" }], read)).rejects.toThrow(/Диск Z:/);
  });

  it("hashes readable sources and leaves the digest empty when a file is missing", async () => {
    const bytes = new TextEncoder().encode("abc");
    const digest = await sourceDigest([{ path: "D:\\a.bin" }], async () => bytes);
    expect(digest).toBe(sha256(new TextEncoder().encode(`D:\\a.bin\n${sha256(bytes)}`)));
    expect(await sourceDigest([{ path: "D:\\missing.bin" }], async () => null)).toBeNull();
  });

  it("drops forbidden catalog rows", () => {
    const records = normalizeCatalog([
      { path: "Z:\\secret\\a.bin", name: "a.bin", size: 1 },
      { path: "D:\\ok\\b.bin", name: "b.bin", size: 2 },
    ]);
    expect(records.map((record) => record.path)).toEqual(["D:\\ok\\b.bin"]);
  });
});

describe("optical progress math", () => {
  it("reports speed and ETA from bytes and elapsed time", () => {
    expect(bytesPerSecond(1000, 2000)).toBe(500);
    expect(bytesPerSecond(0, 2000)).toBe(0);
    expect(etaSeconds(500, 1000, 500)).toBe(1);
    expect(etaSeconds(0, 1000, 0)).toBe(8_640_000);
  });
});
