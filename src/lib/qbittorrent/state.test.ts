import { describe, expect, it } from "vitest";

import { mapRawTorrent, normalizeState, usesStopApi } from "@/lib/qbittorrent/state";

describe("qBittorrent states", () => {
  it("maps v4 pause and v5 stop onto the same labels", () => {
    expect(normalizeState("pausedDL")).toBe("paused");
    expect(normalizeState("stoppedUP")).toBe("paused");
    expect(normalizeState("uploading")).toBe("seeding");
    expect(normalizeState("stalledDL")).toBe("stalled");
    expect(normalizeState("metaDL")).toBe("metadata");
    expect(normalizeState("missingFiles")).toBe("missing");
    expect(normalizeState("moving")).toBe("moving");
  });

  it("uses stop/start only from WebAPI 2.11", () => {
    expect(usesStopApi("2.8.19")).toBe(false);
    expect(usesStopApi("2.9.3")).toBe(false);
    expect(usesStopApi("2.11.0")).toBe(true);
    expect(usesStopApi("2.11.4")).toBe(true);
  });

  it("reads save path, content path and tags from the info payload", () => {
    const torrent = mapRawTorrent({
      hash: "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
      name: "Fixture",
      state: "stoppedDL",
      progress: 0.5,
      size: 1000,
      total_size: 2000,
      save_path: "D:\\Downloads",
      content_path: "D:\\Downloads\\Fixture",
      tags: "a, b",
      eta: 8640000,
    });
    expect(torrent.hash).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(torrent.state).toBe("paused");
    expect(torrent.savePath).toBe("D:\\Downloads");
    expect(torrent.contentPath).toBe("D:\\Downloads\\Fixture");
    expect(torrent.totalSize).toBe(2000);
    expect(torrent.tags).toEqual(["a", "b"]);
  });
});
