import { describe, expect, it } from "vitest";

import { classify } from "@/lib/content/classify";

describe("classify downloads", () => {
  it("prefers folder signature over extension", () => {
    const result = classify({
      name: "Random.mkv",
      savePath: "S:\\games\\Incoming",
      files: [{ name: "Random.mkv", size: 2_000_000_000 }],
    });
    expect(result).toMatchObject({ kind: "game", reason: "folder" });
  });

  it("reads a PSP iso as a PSP game, including a tiny one", () => {
    const tiny = classify({
      name: "God of War (PSP)",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      files: [{ name: "God of War (PSP)/ISO/ULUS10479.iso", size: 1 }],
    });
    const huge = classify({
      name: "God of War (PSP)",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      files: [{ name: "God of War (PSP)/ISO/ULUS10479.iso", size: 1_800_000_000 }],
    });
    expect(tiny).toMatchObject({ kind: "game", gameSubtype: "psp" });
    expect(huge).toMatchObject({ kind: "game", gameSubtype: "psp" });
    expect(["folder", "extension"]).toContain(tiny.reason);
    expect(["folder", "extension"]).toContain(huge.reason);
    expect(huge.detail.toLowerCase()).not.toContain("размер");
  });

  it("keeps a large movie mkv as a movie", () => {
    const result = classify({
      name: "Интерстеллар (2014) 2160p UHD",
      savePath: "/Volumes/vault/Cinema",
      files: [{ name: "Interstellar.2014.2160p.mkv", size: 62_400_000_000 }],
    });
    expect(result.kind).toBe("movie");
    expect(["folder", "extension"]).toContain(result.reason);
    expect(result.kind).not.toBe("game");
  });

  it("reads S01E02 as a series", () => {
    const result = classify({
      name: "Slow Horses S01E02",
      files: [{ name: "Slow.Horses.S01E02.1080p.mkv", size: 1_400_000_000 }],
    });
    expect(result).toMatchObject({ kind: "series", reason: "extension" });
    expect(classify({ name: "Сериал.S01E02" }).kind).toBe("series");
  });

  it("reads flac as music and pdf as documents", () => {
    expect(
      classify({
        name: "NieR Automata OST",
        files: [
          { name: "01.flac", size: 42_000_000 },
          { name: "02.flac", size: 68_000_000 },
          { name: "booklet.pdf", size: 12_000_000 },
        ],
      }),
    ).toMatchObject({ kind: "music", reason: "extension" });
    expect(classify({ name: "Заметки", files: [{ name: "notes.pdf", size: 2_000_000 }] })).toMatchObject({
      kind: "document",
      reason: "extension",
    });
  });

  it("does not treat an ambiguous big bin as a game", () => {
    const result = classify({
      name: "dump.bin",
      savePath: "D:\\Downloads",
      files: [{ name: "dump.bin", size: 80_000_000_000 }],
    });
    expect(result.kind).toBe("other");
    expect(result.kind).not.toBe("game");
  });

  it("does not treat a game exe in an x64 folder as software", () => {
    const result = classify({
      name: "Cyberpunk 2077",
      savePath: "D:\\Games",
      files: [{ name: "Cyberpunk 2077/bin/x64/Cyberpunk2077.exe", size: 90_000_000 }],
    });
    expect(result).toMatchObject({ kind: "game", gameSubtype: "pc" });
    expect(["folder", "extension"]).toContain(result.reason);
  });

  it("lets a user override beat the guess", () => {
    const result = classify({
      name: "God of War (PSP)",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      files: [{ name: "ULUS10479.iso", size: 1_800_000_000 }],
      override: { kind: "music", gameSubtype: null },
    });
    expect(result).toMatchObject({ kind: "music", gameSubtype: null, reason: "override" });
  });

  it("lets the user set a game subtype over the guess", () => {
    const result = classify({
      name: "God of War (PSP)",
      files: [{ name: "game.iso", size: 10 }],
      override: { kind: "game", gameSubtype: "pc" },
    });
    expect(result).toMatchObject({ kind: "game", gameSubtype: "pc", reason: "override" });
  });
});
