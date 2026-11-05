import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDisk, ingestProbe, listDisks, saveDisks, searchDisks, updateDiskFiles } from "@/lib/kernel/catalog";
import { demoDisks } from "@/lib/kernel/demo-seed";
import { listJobs } from "@/lib/kernel/jobs";
import type { DiskProbe } from "@/lib/kernel/types";

function probe(patch: Partial<DiskProbe> = {}): DiskProbe {
  return {
    serial: "SN-1",
    volumeUuid: "UUID-1",
    filesystem: "ntfs",
    hostId: "demo-pc",
    os: "win32",
    mountPoints: ["E:\\"],
    label: "Полка",
    totalBytes: 100,
    freeBytes: 40,
    online: true,
    elevated: false,
    ...patch,
  };
}

describe("disk catalog", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-catalog-"));
    process.env.SKLAD_DATA_DIR = dir;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("keeps one record when the letter changes and when the volume is mounted twice", async () => {
    await ingestProbe(probe());
    await ingestProbe(probe({ mountPoints: ["F:\\"] }));
    expect(await listDisks()).toHaveLength(1);
    expect((await listDisks())[0]?.mounts.map((mount) => mount.mountPoint)).toEqual(["F:\\"]);

    const dup = await ingestProbe(
      probe({
        os: "darwin",
        hostId: "demo-mac",
        filesystem: "exfat",
        mountPoints: ["/Volumes/vault", "/Volumes/vault-1"],
      }),
    );
    expect(dup.duplicateMount).toBe(true);
    const disks = await listDisks();
    expect(disks).toHaveLength(1);
    expect(disks[0]?.mounts.filter((mount) => mount.hostId === "demo-mac")).toHaveLength(2);
  });

  it("stores a clone separately and does not merge file lists", async () => {
    const first = await ingestProbe(probe({ serial: "SN-A", volumeUuid: "UUID-SAME", label: "Оригинал" }));
    const disks = await listDisks();
    disks[0]!.files = [{ path: "only-original.txt", size: 4 }];
    await saveDisks(disks);
    const clone = await ingestProbe(probe({ serial: "SN-B", volumeUuid: "UUID-SAME", label: "Клон", mountPoints: ["G:\\"] }));
    expect(clone.cloneOf).toBe(first.disk.id);
    expect(clone.created).toBe(true);
    const all = await listDisks();
    expect(all).toHaveLength(2);
    expect(all.find((disk) => disk.id === first.disk.id)?.files).toEqual([{ path: "only-original.txt", size: 4 }]);
    expect(all.find((disk) => disk.id === clone.disk.id)?.files).toEqual([]);
  });

  it("enqueues a read-only index and does not delete files when the scan later errors", async () => {
    const seeded = demoDisks()[0]!;
    await saveDisks([seeded]);
    const result = await ingestProbe(
      probe({
        serial: seeded.serial,
        volumeUuid: seeded.volumeUuid,
        filesystem: "exfat",
        hostId: "demo-mac",
        os: "darwin",
        mountPoints: ["/Volumes/vault"],
        label: seeded.label,
      }),
    );
    expect(result.indexJob?.kind).toBe("index");
    expect(result.indexJob?.payload.readOnly).toBe(true);
    expect(result.indexJob?.state).toBe("queued");
    expect((await listJobs()).every((job) => job.kind !== "compact" && job.kind !== "move")).toBe(true);
    await updateDiskFiles(seeded.id, [], "error", null, "сбой");
    expect((await getDisk(seeded.id)).files.map((file) => file.path)).toEqual(seeded.files.map((file) => file.path));
  });

  it("names the offline disk a search hit tells you to plug in", () => {
    const page = searchDisks(demoDisks(), "день рождения", 0, 10);
    expect(page.total).toBe(1);
    expect(page.items[0]?.label).toBe("Семейный архив");
    expect(page.items[0]?.online).toBe(false);
    expect(page.items[0]?.message).toMatch(/Подключите/);
    expect(page.items[0]?.message).toMatch(/Семейный архив/);
  });
});
