import { describe, expect, it } from "vitest";

import { planIndexCommands } from "@/addons/drives/commands";
import { executeIndexPlan } from "@/addons/drives/execute-index";

const handlers = {
  readMft: async () => ({ files: [], complete: true }),
  readUsn: async () => ({
    delta: {
      upserts: [{ relativePath: "new.txt", name: "new.txt", kind: "file" as const, size: 3, mtimeMs: 1 }],
      deletes: [],
      complete: true,
    },
  }),
  walk: async () => ({ files: [], complete: true }),
  readEvents: async () => ({
    delta: { upserts: [], deletes: ["old.txt"], complete: true },
    cursor: "77",
    lost: false,
  }),
};

describe("incremental index", () => {
  it("does not read the MFT or walk when the USN cursor is still valid", async () => {
    const commands = planIndexCommands({
      filesystem: "NTFS",
      platform: "win32",
      elevated: true,
      busy: false,
      usnCheckpoint: true,
      incremental: "usn",
    });
    expect(commands.map((command) => command.op)).toEqual(["identify-volume", "stat-volume", "read-usn"]);
    const result = await executeIndexPlan(
      { filesystem: "NTFS", platform: "win32", elevated: true, busy: false, usnCheckpoint: true, incremental: "usn" },
      handlers,
    );
    expect(result.called).toEqual(["readUsn"]);
    expect(result.payload.delta?.upserts[0]?.relativePath).toBe("new.txt");
    expect(result.journalLost).toBeUndefined();
  });

  it("asks for one new MFT snapshot when the USN journal is lost and does not walk", async () => {
    const result = await executeIndexPlan(
      { filesystem: "NTFS", platform: "win32", elevated: true, busy: false, usnCheckpoint: true, incremental: "usn" },
      { ...handlers, readUsn: async () => ({ delta: null }) },
    );
    expect(result.called).toEqual(["readUsn"]);
    expect(result.journalLost).toBe(true);
    expect(result.payload.message).toMatch(/Обход папок не запускался/);
  });

  it("applies FSEvents from the saved cursor and walks only when history was dropped", async () => {
    const commands = planIndexCommands({
      filesystem: "APFS",
      platform: "darwin",
      elevated: false,
      busy: false,
      usnCheckpoint: false,
      incremental: "fsevents",
    });
    expect(commands.map((command) => command.op)).not.toContain("walk");
    const caughtUp = await executeIndexPlan(
      { filesystem: "APFS", platform: "darwin", elevated: false, busy: false, usnCheckpoint: false, incremental: "fsevents" },
      handlers,
    );
    expect(caughtUp.called).toEqual(["readEvents"]);
    expect(caughtUp.cursor).toBe("77");
    expect(caughtUp.payload.delta?.deletes).toEqual(["old.txt"]);
    const lost = await executeIndexPlan(
      { filesystem: "APFS", platform: "darwin", elevated: false, busy: false, usnCheckpoint: false, incremental: "fsevents" },
      { ...handlers, readEvents: async () => ({ delta: null, cursor: "1", lost: true }) },
    );
    expect(lost.journalLost).toBe(true);
    expect(lost.called).toEqual(["readEvents"]);
  });
});
