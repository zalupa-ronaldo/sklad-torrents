import { describe, expect, it } from "vitest";

import { hiddenByDataTwin, isBrowsableDisk, isStripDisk, visibleShelfDisks } from "@/addons/drives/inventory";
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
});
