import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mayReplaceOriginal, pauseAtFile, queuePercent, replaceOriginalFile, sampleSpeed } from "@/lib/transcode/file-gate";

describe("file gate", () => {
  it("drops an unfinished output on pause and keeps queue speed numbers finite", () => {
    expect(pauseAtFile(true)).toEqual({ publish: false, discardPartial: true, touchSource: false });
    expect(pauseAtFile(false).publish).toBe(true);
    expect(sampleSpeed(100, 250, 500)).toBe(300);
    expect(queuePercent([{ percent: 20 }, { percent: 80 }])).toBe(50);
  });

  it("replaces the original only after the owner flag, checks, and both hashes", async () => {
    expect(mayReplaceOriginal({
      replaceOriginal: false,
      verified: true,
      durationOk: true,
      tracksOk: true,
      decodeOk: true,
      sourceSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
    }).replace).toBe(false);
    const dir = await mkdtemp(path.join(tmpdir(), "sklad-replace-"));
    const source = path.join(dir, "film.mkv");
    const output = path.join(dir, "film-new.mkv");
    await writeFile(source, "original-bytes");
    await writeFile(output, "encoded-bytes");
    const { createHash } = await import("node:crypto");
    const sourceSha = createHash("sha256").update("original-bytes").digest("hex");
    const outputSha = createHash("sha256").update("encoded-bytes").digest("hex");
    const refused = await replaceOriginalFile({ source, output, sourceSha256: sourceSha, outputSha256: outputSha, allow: false });
    expect(refused.replaced).toBe(false);
    expect(await readFile(source, "utf8")).toBe("original-bytes");
    const done = await replaceOriginalFile({ source, output, sourceSha256: sourceSha, outputSha256: outputSha, allow: true });
    expect(done.replaced).toBe(true);
    expect(await readFile(source, "utf8")).toBe("encoded-bytes");
    expect((await stat(output)).isFile()).toBe(true);
    await expect(stat(`${source}.sklad-bak`)).rejects.toThrow();
  });
});
