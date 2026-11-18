import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseDiskArbLine } from "../../../agents/lib/volume-events.mts";
import { IDLE_WORK_WAKES_PER_MINUTE, idleWorkWakes } from "@/lib/idle/budget";

describe("idle work", () => {
  it("records the timer audit and keeps the boot path free of idle intervals", () => {
    expect(idleWorkWakes("before")).toBe(330);
    expect(idleWorkWakes("after")).toBe(0);
    expect(IDLE_WORK_WAKES_PER_MINUTE.after.jobWorkers).toBe(0);
    const root = process.cwd();
    const boot = readFileSync(path.join(root, "src/instrumentation.ts"), "utf8");
    expect(boot).not.toMatch(/setInterval/);
    expect(boot).not.toMatch(/ensureSchedulerLoop/);
    const discovery = readFileSync(path.join(root, "src/lib/localsend/discovery.ts"), "utf8");
    expect(discovery).not.toMatch(/setInterval/);
    const worker = readFileSync(path.join(root, "src/lib/jobs/mock-worker.ts"), "utf8");
    expect(worker).not.toMatch(/schedule\(claimed/);
  });

  it("accepts a DiskArbitration mount and drops a path that leaves /Volumes", () => {
    expect(parseDiskArbLine('{"type":"attach","mount":"/Volumes/vault"}')).toEqual({ type: "attach", mount: "/Volumes/vault" });
    expect(parseDiskArbLine('{"type":"detach","mount":"/Volumes/vault"}')?.type).toBe("detach");
    expect(parseDiskArbLine('{"type":"attach","mount":"/Volumes/../etc"}')).toBeNull();
    expect(parseDiskArbLine('{"type":"attach","mount":"/tmp/vault"}')).toBeNull();
    expect(parseDiskArbLine("not-json")).toBeNull();
  });
});
