import { describe, expect, it } from "vitest";

import { handbrakeHref, moveGameHref, torrentReadyForMedia } from "@/addons/media-games/links";

describe("links out of a finished torrent", () => {
  it("opens HandBrake and the move wizard with the content path", () => {
    const input = { os: "darwin" as const, path: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv", name: "Interstellar" };
    expect(handbrakeHref(input)).toContain("/tools/transcode?");
    expect(handbrakeHref(input)).toContain("host=mac-local");
    expect(handbrakeHref(input)).toContain("os=darwin");
    expect(moveGameHref({ os: "win32", path: "D:\\Games\\Control", name: "Control" })).toContain("host=pc-agent");
    expect(torrentReadyForMedia(1, [])).toBe(true);
    expect(torrentReadyForMedia(0.4, [{ progress: 0.2, priority: 1 }])).toBe(false);
    expect(
      torrentReadyForMedia(0.5, [
        { progress: 1, priority: 1 },
        { progress: 0.2, priority: 0 },
      ]),
    ).toBe(true);
  });
});
