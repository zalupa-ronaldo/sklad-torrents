import { describe, expect, it } from "vitest";

import { ToolsError } from "@/addons/media-games/errors";
import {
  applyCopy,
  applyVerify,
  buildVerifyResult,
  confirmSourceDelete,
  libraryFromPlan,
  markSourceDeleted,
  planMove,
} from "@/addons/media-games/move";

const receipt = { files: 40, bytes: 1000, marker: "mock-copy" };

function verifiedPlan() {
  const planned = planMove({
    hostId: "pc-agent",
    os: "win32",
    name: "Control",
    sourcePath: "D:\\Games\\Control",
    destinationPath: "C:\\Games\\Control",
  });
  const copied = applyCopy(planned, receipt);
  return applyVerify(copied, buildVerifyResult(receipt, true));
}

describe("move planner", () => {
  it("requires verify before delete and keeps the delete flag false until confirm", () => {
    const planned = planMove({
      hostId: "mac-local",
      os: "darwin",
      name: "Hades",
      sourcePath: "/Users/me/Games/Hades",
      destinationPath: "/Volumes/vault/Games/Hades",
    });
    expect(planned).toMatchObject({ verified: false, deleteSource: false, sourceDeleted: false });
    expect(confirmSourceDelete(planned, true).deleteSource).toBe(false);
    expect(() => markSourceDeleted(confirmSourceDelete(planned, true))).toThrow(ToolsError);

    const copied = applyCopy(planned, receipt);
    expect(copied.deleteSource).toBe(false);
    const failed = applyVerify(copied, buildVerifyResult(receipt, false));
    expect(failed).toMatchObject({ phase: "verify-failed", verified: false, deleteSource: false, sourceDeleted: false });
    expect(confirmSourceDelete(failed, true).deleteSource).toBe(false);
    expect(() => libraryFromPlan(failed, "job-1", 10)).toThrow(/проверки/);

    const verified = verifiedPlan();
    expect(verified.verified).toBe(true);
    expect(verified.deleteSource).toBe(false);
    expect(confirmSourceDelete(verified, false)).toMatchObject({ deleteSource: false, sourceDeleted: false });
    const confirmed = confirmSourceDelete(verified, true);
    expect(confirmed).toMatchObject({ deleteSource: true, sourceDeleted: false });
    const deleted = markSourceDeleted(confirmed);
    expect(deleted.sourceDeleted).toBe(true);
  });

  it("updates the library record only after a verified move", () => {
    const verified = verifiedPlan();
    expect(libraryFromPlan(verified, "job-9", 50)).toEqual({
      id: "lib-job-9",
      name: "Control",
      hostId: "pc-agent",
      oldPath: "D:\\Games\\Control",
      newPath: "C:\\Games\\Control",
      status: "verified",
      jobId: "job-9",
      updatedAt: 50,
    });
    const moved = markSourceDeleted(confirmSourceDelete(verified, true));
    expect(libraryFromPlan(moved, "job-9", 60).status).toBe("moved");
  });
});
