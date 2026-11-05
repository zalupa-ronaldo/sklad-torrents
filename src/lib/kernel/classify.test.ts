import { describe, expect, it } from "vitest";

import { classify } from "@/lib/kernel/classify";

describe("content classification", () => {
  it("lets a user override beat the file name", () => {
    expect(classify({ name: "God of War (PSP)", override: "movie", sizeBytes: 9_000_000_000 }).kind).toBe("movie");
  });

  it("recognizes PSP, movies, series, music and installers by name and extension", () => {
    expect(classify({ name: "God of War (PSP)", path: "ULUS10479.iso" }).kind).toBe("game-psp");
    expect(classify({ name: "Интерстеллар (2014) 2160p UHD", path: "Interstellar.mkv" }).kind).toBe("movie");
    expect(classify({ name: "Show.S01E02.1080p.mkv" }).kind).toBe("series");
    expect(classify({ name: "NieR:Automata OST", path: "01.flac" }).kind).toBe("music");
    expect(classify({ name: "Ubuntu 24.04.3 desktop amd64", path: "ubuntu.iso" }).kind).toBe("software");
    expect(classify({ name: "Control Ultimate Edition", path: "Control_DX12.exe" }).kind).toBe("game-pc");
    expect(classify({ name: "notes", path: "readme.pdf" }).kind).toBe("document");
  });

  it("does not treat size as a game", () => {
    const small = classify({ name: "backup.bin", sizeBytes: 10 });
    const huge = classify({ name: "backup.bin", sizeBytes: 80_000_000_000_000 });
    expect(small.kind).toBe("other");
    expect(huge.kind).toBe(small.kind);
    expect(huge.reason).toMatch(/Размер не используется/);
  });

  it("applies a custom rule before extensions", () => {
    expect(
      classify({
        name: "archive.rar",
        customRules: [{ id: "1", pattern: "archive", kind: "document" }],
      }).kind,
    ).toBe("document");
  });
});
