import { describe, expect, it } from "vitest";

import { encodeArgv } from "@/lib/transcode/encode-plan";
import { afterHardwareCrash, isNativeEncodeCrash, routeAv1, softwareAv1, VCE_AV1_CRASH, VCE_AV1_CRASH_SIGNED } from "@/lib/transcode/vce-fallback";

const win = ["svt_av1", "svt_av1_10bit", "vce_av1", "vce_av1_10bit", "vce_h264", "vce_h265", "x264", "x265"];

describe("AMD VCE AV1 fallback", () => {
  it("uses VideoToolbox or VCE for HEVC and H.264, and still refuses AV1 hardware", () => {
    const facts = { format: "", duration: 1, videoCodec: "h264", audio: 0, subtitles: 0, chapters: 0, hdr: false };
    const hevc = encodeArgv({
      binary: "HandBrakeCLI",
      source: "/tmp/in.mp4",
      output: "/tmp/out.mp4",
      codec: "hevc",
      container: "mp4",
      sourceFacts: facts,
      encoders: win,
      prefer: "hardware",
    });
    expect(hevc).toContain("vce_h265");
    const mac = encodeArgv({
      binary: "HandBrakeCLI",
      source: "/tmp/in.mp4",
      output: "/tmp/out.mp4",
      codec: "h264",
      container: "mp4",
      sourceFacts: facts,
      encoders: ["vt_h264", "x264"],
      prefer: "hardware",
    });
    expect(mac).toContain("vt_h264");
    expect(mac.join("\n")).not.toMatch(/vce_av1/);
  });

  it("never puts vce_av1 in the argv and uses svt when it is listed", () => {
    const argv = encodeArgv({
      binary: "HandBrakeCLI",
      source: "D:\\in.mp4",
      output: "D:\\out.mkv",
      codec: "av1",
      container: "mkv",
      sourceFacts: { format: "", duration: 1, videoCodec: "h264", audio: 0, subtitles: 0, chapters: 0, hdr: false },
      encoders: win,
      prefer: "hardware",
    });
    expect(argv).toContain("svt_av1");
    expect(argv.join("\n")).not.toMatch(/vce_av1/);
    expect(softwareAv1(win, false)).toBe("svt_av1");
    expect(softwareAv1(["vce_av1"], false)).toBeNull();
  });

  it("retries software once after the known crash and does not touch the source", () => {
    expect(isNativeEncodeCrash(VCE_AV1_CRASH)).toBe(true);
    expect(isNativeEncodeCrash(VCE_AV1_CRASH_SIGNED)).toBe(true);
    const first = afterHardwareCrash({ code: VCE_AV1_CRASH, encoder: "vce_av1", retried: false, encoders: win, hdr: false, codec: "av1" });
    expect(first).toMatchObject({ retry: true, encoder: "svt_av1", discardPartial: true, touchSource: false });
    const second = afterHardwareCrash({ code: VCE_AV1_CRASH, encoder: "svt_av1", retried: true, encoders: win, hdr: false, codec: "av1" });
    expect(second).toMatchObject({ retry: false, discardPartial: true, touchSource: false });
    const hevc = afterHardwareCrash({ code: 139, encoder: "vce_h265", retried: false, encoders: win, hdr: false, codec: "hevc" });
    expect(hevc.retry).toBe(false);
    expect(routeAv1({ allowSoftware: false, encoders: win })).toMatchObject({ allowSoftware: true, fallback: true, block: false });
    expect(routeAv1({ allowSoftware: false, encoders: ["x264"] })).toMatchObject({ block: false, fallback: false, allowSoftware: false });
    expect(routeAv1({ allowSoftware: false, encoders: ["vce_av1"] })).toMatchObject({ block: true, allowSoftware: false });
  });
});
