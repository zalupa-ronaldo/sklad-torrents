import { describe, expect, it } from "vitest";

import { SkladError } from "@/lib/kernel/errors";
import { matchDisk, normalizeSerial, normalizeVolumeUuid } from "@/lib/kernel/identity";

const vault = { id: "disk-vault", serial: "SN-VAULT-1001", volumeUuid: "UUID-VAULT-1001" };

describe("disk identity", () => {
  it("normalizes serial and uuid without keeping a drive letter", () => {
    expect(normalizeSerial(" sn-vault-1001 ")).toBe("SNVAULT1001");
    expect(normalizeVolumeUuid("{UUID-VAULT-1001}")).toBe("uuid-vault-1001");
  });

  it("matches the same serial and uuid and ignores mount points because they are not inputs", () => {
    expect(matchDisk([vault], { serial: "sn-vault-1001", volumeUuid: "uuid-vault-1001" })).toEqual({
      kind: "same",
      diskId: "disk-vault",
    });
  });

  it("treats the same uuid with another serial as a clone", () => {
    expect(matchDisk([vault], { serial: "SN-CLONE-9", volumeUuid: vault.volumeUuid })).toEqual({
      kind: "clone",
      diskId: "disk-vault",
    });
  });

  it("does not merge a different uuid even when the serial matches", () => {
    expect(matchDisk([vault], { serial: vault.serial, volumeUuid: "other-volume" })).toEqual({
      kind: "new",
      diskId: null,
    });
  });

  it("refuses to identify a disk without serial and uuid", () => {
    expect(() => matchDisk([], { serial: "E:", volumeUuid: "" })).toThrow(SkladError);
  });
});
