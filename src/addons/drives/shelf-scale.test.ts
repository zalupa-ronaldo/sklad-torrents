import { describe, expect, it } from "vitest";

import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { indexFetchPlan } from "@/addons/drives/shelf-plan";
import { toView } from "@/addons/drives/service";
import type { DiskRecord, IndexedFile } from "@/addons/drives/types";

const RECORDS = 1_500_000;

function disk(files: IndexedFile[], summary?: DiskRecord["summary"]): DiskRecord {
  return {
    id: "disk-data",
    serial: "APPLE",
    serialNorm: "apple",
    volumeUuid: "F21D84D5-4718-4971-A377-D9ECBA00E401",
    uuidNorm: "f21d84d547184971a377d9ecba00e401",
    filesystem: "APFS",
    label: "Data",
    namedByUser: false,
    volumeName: "Data",
    totalBytes: 251_000_000_000,
    freeBytes: 40_000_000_000,
    lastSeenAt: "2026-11-06T22:00:00.000Z",
    lastHostId: "mac-mini",
    lastHostName: "Mac mini",
    pathStyle: "posix",
    lastMountPath: "/System/Volumes/Data",
    priorMountPath: "",
    connectedHosts: [{ id: "mac-mini", name: "Mac mini", os: "darwin", elevated: false, mountPaths: ["/System/Volumes/Data"] }],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "walk", progress: 1, message: "Индекс APFS готов.", elevated: false },
    files,
    summary,
    indexRevision: "rev-data",
  };
}

describe("million-row shelf", () => {
  it("does not fetch or scan a manual-only volume that has no index", () => {
    expect(indexFetchPlan({ state: undefined, recordCount: 0 })).toBe("none");
    expect(indexFetchPlan({ state: "idle", revision: "z", recordCount: 0 })).toBe("none");
    expect(indexFetchPlan({ state: "complete", revision: "data", recordCount: RECORDS })).toBe("defer");
    expect(indexFetchPlan({ state: "complete", revision: "data", recordCount: RECORDS, pendingRevision: "data" })).toBe("defer");
    expect(indexFetchPlan({ state: "complete", revision: "data", recordCount: RECORDS, pendingRevision: "data", ingestActive: true })).toBe("skip");
    expect(indexFetchPlan({ state: "complete", revision: "small", recordCount: 12 })).toBe("inline");
  });

  it("totals 1.5M records once and serves the shelf without walking them again", () => {
    const started = process.memoryUsage().heapUsed;
    const clock = performance.now();
    const files: IndexedFile[] = new Array(RECORDS);
    for (let i = 0; i < RECORDS; i += 1) {
      const wof = i === 10;
      files[i] = {
        relativePath: `d/${i}.bin`,
        name: `${i}.bin`,
        kind: "file",
        size: 4096,
        onDisk: wof ? 1024 : undefined,
        compression: wof ? "wof" : undefined,
        mtimeMs: 0,
        sidecarCategory: null,
        categories: i % 1000 === 0 ? ["media"] : [],
      };
    }
    const builtMs = performance.now() - clock;
    const sumClock = performance.now();
    const summary = summarizeIndexed(files);
    const sumMs = performance.now() - sumClock;
    expect(summary.fileCount).toBe(RECORDS);
    expect(summary.indexedBytes).toBe(RECORDS * 4096);
    expect(files[10]?.onDisk).toBe(1024);
    expect(files[10]?.compression).toBe("wof");

    let walked = 0;
    const hidden = new Proxy(files, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop !== "length" && Number.isInteger(Number(prop))) walked += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const viewClock = performance.now();
    const view = toView([disk(hidden as IndexedFile[], summary)]);
    const viewMs = performance.now() - viewClock;
    const heapMb = Math.round((process.memoryUsage().heapUsed - started) / 1_048_576);
    expect(view[0]?.fileCount).toBe(RECORDS);
    expect(view[0]?.indexedBytes).toBe(RECORDS * 4096);
    expect(view[0]?.sizesReady).toBe(true);
    expect(view[0]?.totalBytes).toBe(251_000_000_000);
    expect(walked).toBe(0);
    expect(viewMs).toBeLessThan(100);
    expect(sumMs).toBeLessThan(5_000);
    console.info(`shelf-scale records=${RECORDS} buildMs=${builtMs.toFixed(0)} summaryMs=${sumMs.toFixed(0)} viewMs=${viewMs.toFixed(1)} heapMb=${heapMb}`);
  }, 120_000);
});
