import { describe, expect, it } from "vitest";

import { torrentDisplayName } from "@/lib/qbittorrent/bencode";

describe("torrent names", () => {
  it("reads info.name from a .torrent payload", () => {
    const pieces = "a".repeat(20);
    const encoded = `d8:announce11:http://t.se4:infod6:lengthi1e4:name9:notes.txt12:piece lengthi16384e6:pieces20:${pieces}ee`;
    expect(torrentDisplayName(new TextEncoder().encode(encoded), "fallback.torrent")).toBe("notes.txt");
  });

  it("falls back to the file name when the payload is not a torrent", () => {
    expect(torrentDisplayName(new TextEncoder().encode("hello"), "Game.iso.torrent")).toBe("Game.iso");
  });
});
