import { describe, expect, it } from "vitest";

import { dedupeShelfDisks, hiddenByDataTwin, isBrowsableDisk, isStripDisk, visibleShelfDisks } from "@/addons/drives/inventory";
import type { DiskView } from "@/addons/drives/types";

function view(partial: Partial<DiskView> & Pick<DiskView, "id" | "label" | "lastMountPath">): DiskView {
  return {
    namedByUser: false,
    volumeName: partial.volumeName ?? partial.label,
    serial: partial.serial ?? "",
    volumeUuid: partial.volumeUuid ?? partial.id,
    filesystem: partial.filesystem ?? "APFS",
    totalBytes: partial.totalBytes ?? 250_000_000_000,
    freeBytes: partial.freeBytes ?? 40_000_000_000,
    online: partial.online ?? true,
    lastSeenAt: "",
    lastHostId: partial.lastHostId ?? "mac-mini",
    lastHostName: "Mac mini",
    mountPaths: partial.mountPaths ?? [partial.lastMountPath],
    priorMountPath: "",
    duplicateMounts: false,
    possibleClone: false,
    clonePeerLabels: [],
    scan: partial.scan ?? { status: "error", strategy: "walk", progress: 0, message: "Индексация прервалась.", elevated: false },
    fileCount: partial.fileCount ?? 0,
    indexedBytes: 0,
    sizesReady: partial.sizesReady ?? true,
    categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 },
    ...partial,
  };
}

describe("disk visibility", () => {
  const data = view({ id: "data", label: "Data", volumeName: "Data", lastMountPath: "/System/Volumes/Data", serial: "APPLE", filesystem: "APFS" });
  const hd = view({ id: "hd", label: "Macintosh HD", volumeName: "Macintosh HD", lastMountPath: "/", serial: "APPLE", filesystem: "APFS" });
  const preboot = view({ id: "preboot", label: "Preboot", lastMountPath: "/System/Volumes/Preboot", serial: "APPLE" });
  const recovery = view({ id: "recovery", label: "Recovery", lastMountPath: "/System/Volumes/Recovery", serial: "APPLE" });
  const vm = view({ id: "vm", label: "VM", lastMountPath: "/System/Volumes/VM", serial: "APPLE" });
  const vault = view({
    id: "vault",
    label: "vault",
    lastMountPath: "/Volumes/vault",
    filesystem: "APFS",
    totalBytes: 1_000_000_000_000,
    serial: "USB",
    fileCount: 0,
    scan: { status: "error", strategy: "walk", progress: 0, message: "предыдущая индексация прервана", elevated: false },
  });
  const z = view({
    id: "z",
    label: "Data",
    volumeName: "Data",
    lastMountPath: "Z:\\",
    mountPaths: ["Z:\\"],
    filesystem: "NTFS",
    totalBytes: 4_000_000_000_000,
    serial: "WRA04CK7",
    lastHostId: "windows-pc",
    fileCount: 0,
    scan: { status: "idle", strategy: "mft-usn", progress: 0, message: "Индекс ещё не построен.", elevated: true },
  });

  it("shows Data and an empty online SSD, and hides the sealed twin plus junk volumes", () => {
    const disks = [data, hd, preboot, recovery, vm, vault, z];
    const shown = visibleShelfDisks(disks).map((disk) => disk.id);
    expect(shown).toEqual(expect.arrayContaining(["data", "vault", "z"]));
    expect(shown).not.toContain("hd");
    expect(shown).not.toContain("preboot");
    expect(shown).not.toContain("recovery");
    expect(shown).not.toContain("vm");
    expect(hiddenByDataTwin(hd, disks)).toBe(true);
    expect(isBrowsableDisk(preboot, disks)).toBe(false);
    expect(isStripDisk(vault, disks)).toBe(true);
    expect(isStripDisk(z, disks)).toBe(true);
  });

  it("keeps Macintosh HD when there is no Data volume", () => {
    expect(isStripDisk(hd, [hd])).toBe(true);
  });

  it("shows one chip per volume uuid and still hides the sealed twin", () => {
    const vaultUuid = "54C64F37-629A-410E-B506-92969EF32EEC";
    const vaultA = view({
      id: "vault",
      label: "vault",
      volumeName: "vault",
      volumeUuid: vaultUuid,
      lastMountPath: "/Volumes/vault",
      serial: "USB",
      totalBytes: 1_000_000_000_000,
      fileCount: 1,
    });
    const vaultB = view({
      id: "vault-new",
      label: "vault",
      volumeName: "vault",
      volumeUuid: "54c64f37-629a-410e-b506-92969ef32eec",
      lastMountPath: "/Volumes/vault 1",
      serial: "USB",
      totalBytes: vaultA.totalBytes,
      fileCount: 10,
    });
    const other = view({
      id: "other",
      label: "vault",
      volumeName: "vault",
      volumeUuid: "99999999-9999-4999-8999-999999999999",
      lastMountPath: "/Volumes/other",
      serial: "OTHER",
      totalBytes: vaultA.totalBytes,
      fileCount: 3,
    });
    const shown = dedupeShelfDisks([vaultA, vaultB, data, hd, other]).map((disk) => disk.id);
    expect(shown.filter((id) => id === "vault" || id === "vault-new")).toHaveLength(1);
    expect(shown).toContain("vault-new");
    expect(shown).toContain("data");
    expect(shown).toContain("other");
    expect(shown).not.toContain("hd");
  });
});
