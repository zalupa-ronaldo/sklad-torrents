import { constants } from "node:os";
import { describe, expect, it } from "vitest";

import { admitMachine, DEFAULT_MACHINE_LIMIT, priorityLevel } from "@/lib/transcode/workload";

describe("per-machine load", () => {
  it("starts one file and waits when the machine is busy, paused, or full", () => {
    expect(admitMachine(DEFAULT_MACHINE_LIMIT, 0).admit).toBe(true);
    expect(admitMachine(DEFAULT_MACHINE_LIMIT, 1).admit).toBe(true);
    expect(admitMachine(DEFAULT_MACHINE_LIMIT, 2).admit).toBe(false);
    expect(admitMachine({ ...DEFAULT_MACHINE_LIMIT, maxParallel: 1 }, 1).admit).toBe(false);
    expect(admitMachine({ ...DEFAULT_MACHINE_LIMIT, paused: true }, 0).reason).toMatch(/пауз/);
    expect(admitMachine({ ...DEFAULT_MACHINE_LIMIT, userBusy: true }, 0).reason).toMatch(/играют|работают/);
    expect(admitMachine({ ...DEFAULT_MACHINE_LIMIT, maxParallel: 2 }, 1).admit).toBe(true);
  });

  it("uses below-normal priority unless the machine asked for normal", () => {
    expect(priorityLevel("below-normal")).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
    expect(priorityLevel("normal")).toBe(constants.priority.PRIORITY_NORMAL);
  });
});
