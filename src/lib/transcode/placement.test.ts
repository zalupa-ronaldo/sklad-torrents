import { describe, expect, it } from "vitest";

import { chooseQueuedFile, fileHome, workerMayTake, type PeerSeat } from "@/lib/transcode/placement";

const pc: PeerSeat = { role: "pc", freeSlots: 1 };
const mac: PeerSeat = { role: "mac", freeSlots: 1 };

describe("where the file lives", () => {
  it("keeps a Windows file on the PC and a Mac file on the Mac", () => {
    expect(fileHome("D:\\Films\\clip.mkv")).toBe("pc");
    expect(fileHome("/mnt/d/Films/clip.mkv")).toBe("pc");
    expect(fileHome("/Volumes/vault/Cinema/clip.mkv")).toBe("mac");
    expect(fileHome("/Users/shared/clip.mkv")).toBe("mac");
    expect(fileHome("/tmp/clip.mp4")).toBe("shared");
  });

  it("does not send a local file across the network while the home machine has a free slot", () => {
    expect(workerMayTake({ source: "D:\\Films\\a.mkv", workerRole: "pc", peers: [mac] })).toMatchObject({ take: true, transport: "local" });
    expect(workerMayTake({ source: "D:\\Films\\a.mkv", workerRole: "mac", peers: [pc] })).toMatchObject({ take: false });
    expect(workerMayTake({ source: "/Volumes/vault/a.mkv", workerRole: "mac", peers: [pc] })).toMatchObject({ take: true, transport: "local" });
    expect(workerMayTake({ source: "/Volumes/vault/a.mkv", workerRole: "pc", peers: [mac] })).toMatchObject({ take: false });
  });

  it("copies with SHA-256 only when the home machine has no free slot", () => {
    const full = workerMayTake({ source: "D:\\Films\\a.mkv", workerRole: "mac", peers: [{ role: "pc", freeSlots: 0 }] });
    expect(full).toMatchObject({ take: true, transport: "copy" });
    expect(full.reason).toMatch(/SHA-256/);
    const paused = workerMayTake({ source: "D:\\Films\\a.mkv", workerRole: "mac", peers: [{ role: "pc", freeSlots: 1, paused: true }] });
    expect(paused.transport).toBe("copy");
    const offline = workerMayTake({ source: "D:\\Films\\a.mkv", workerRole: "mac", peers: [] });
    expect(offline.transport).toBe("copy");
    expect(workerMayTake({ source: "/tmp/a.mp4", workerRole: "pc", peers: [mac] }).transport).toBe("copy");
  });

  it("gives each machine its own file before a newer file that lives elsewhere", () => {
    const jobs = [
      { id: "new-on-pc", source: "D:\\Films\\new.mkv" },
      { id: "old-on-mac", source: "/Volumes/vault/old.mkv" },
    ];
    expect(chooseQueuedFile({ jobs, workerRole: "mac", peers: [pc] })?.job.id).toBe("old-on-mac");
    expect(chooseQueuedFile({ jobs, workerRole: "pc", peers: [mac] })?.job.id).toBe("new-on-pc");
    expect(chooseQueuedFile({ jobs: [jobs[0]!], workerRole: "mac", peers: [{ role: "pc", freeSlots: 0 }] })?.transport).toBe("copy");
  });
});
