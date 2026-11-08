import { describe, expect, it } from "vitest";

import {
  assertEncodePaths,
  encodeArgv,
  mediaFromProbe,
  pathInside,
  requirementBlock,
  scratchFits,
  capabilityFromHelp,
  verifyMedia,
  type HandBrakeCapability,
} from "@/lib/transcode/encode-plan";

const capability: HandBrakeCapability = {
  present: true,
  version: "1.7.2",
  encoders: ["svt_av1", "svt_av1_10bit", "x265", "x265_10bit", "x264"],
  audioCopy: true,
  markers: true,
  subtitles: true,
  hardwareAv1: false,
  advertisedHardwareAv1: [],
};

describe("encode plan", () => {
  it("rejects Windows E and Z paths before any file is opened", () => {
    expect(() => assertEncodePaths(["E:\\films\\a.mkv", "/tmp/out.mp4"])).toThrow(/E и Z/);
    expect(() => assertEncodePaths(["/tmp/in.mp4", "Z:\\out.mp4"])).toThrow(/E и Z/);
    expect(() => assertEncodePaths(["\\\\?\\E:\\staging\\a.mp4"])).toThrow(/E и Z/);
    expect(() => assertEncodePaths(["/tmp/in.mp4"])).not.toThrow();
  });

  it("blocks missing subtitles, chapters, HDR and audio copy instead of dropping them", () => {
    expect(requirementBlock({ ...quiet(), audio: 1 }, { ...capability, audioCopy: false }, "av1")).toMatch(/звук/);
    expect(requirementBlock({ ...quiet(), subtitles: 2 }, { ...capability, subtitles: false }, "av1")).toMatch(/субтитр/);
    expect(requirementBlock({ ...quiet(), chapters: 4 }, { ...capability, markers: false }, "av1")).toMatch(/глав/);
    expect(requirementBlock({ ...quiet(), hdr: true }, { ...capability, encoders: ["svt_av1", "x264"] }, "av1")).toMatch(/HDR/);
    expect(requirementBlock({ ...quiet(), hdr: true }, capability, "h264")).toMatch(/HDR/);
    expect(requirementBlock({ ...quiet(), hdr: true }, capability, "av1")).toBeNull();
  });

  it("builds an AV1 argv and never names HEVC", () => {
    const argv = encodeArgv({
      binary: "/usr/bin/HandBrakeCLI",
      source: "/tmp/in clip.mp4",
      output: "/tmp/out.mp4",
      codec: "av1",
      sourceFacts: { ...quiet(), subtitles: 1 },
      encoders: capability.encoders,
    });
    expect(argv).toContain("svt_av1");
    expect(argv.join("\n")).not.toMatch(/x26[45]|hevc|h264/i);
    expect(argv[0]).toBe("/usr/bin/HandBrakeCLI");
    expect(argv).toContain("/tmp/in clip.mp4");
  });

  it("does not treat exit 0 or a smaller file as verification", () => {
    const source = { ...quiet(), duration: 1, audio: 1 };
    const bad = verifyMedia({
      codec: "av1",
      source,
      output: { ...quiet(), format: "mp4", duration: 1, videoCodec: "h264", audio: 1 },
      decodeOk: true,
      exitCode: 0,
    });
    expect(bad.verified).toBe(false);
    expect(bad.presetAccepted).toBe(false);
    const good = verifyMedia({
      codec: "av1",
      source,
      output: { ...quiet(), format: "mov,mp4", duration: 1.02, videoCodec: "av1", audio: 1 },
      decodeOk: true,
      exitCode: 0,
    });
    expect(good.verified).toBe(true);
    const unread = verifyMedia({
      codec: "av1",
      source,
      output: { ...quiet(), format: "mp4", duration: 1, videoCodec: "av1", audio: 0 },
      decodeOk: false,
      exitCode: 0,
    });
    expect(unread.verified).toBe(false);
  });

  it("keeps an outside path and an unknown scratch from being treated as owned space", () => {
    expect(pathInside("/tmp/job", "/tmp/job/staging/a.mp4")).toBe(true);
    expect(pathInside("/tmp/job", "/tmp/original.mp4")).toBe(false);
    expect(pathInside("/tmp/job", "/tmp/job-extra/a.mp4")).toBe(false);
    expect(scratchFits(null, 100).ok).toBe(false);
    expect(scratchFits(10, 100).ok).toBe(false);
  });

  it("reads 1.11.1 help names and does not treat vce_av1 or a missing vt_av1 as a functional pass", () => {
    const mac = capabilityFromHelp(`Select video encoder:\n svt_av1\n svt_av1_10bit\n vt_h264\n vt_h265\n vt_h265_10bit\n vt_prores\n --encoder-preset`, "HandBrake 1.11.1");
    const win = capabilityFromHelp(`Select video encoder:\n svt_av1\n svt_av1_10bit\n vce_av1\n vce_av1_10bit\n vce_h264\n vce_h265\n vce_h265_10bit\n --encoder-preset`, "HandBrake 1.11.1");
    expect(mac.version).toBe("1.11.1");
    expect(mac.encoders).toEqual(["svt_av1", "svt_av1_10bit", "vt_h264", "vt_h265", "vt_h265_10bit", "vt_prores"]);
    expect(mac.hardwareAv1).toBe(false);
    expect(mac.advertisedHardwareAv1).toEqual([]);
    expect(mac.encoders).not.toContain("vt_av1");
    expect(win.advertisedHardwareAv1).toEqual(["vce_av1", "vce_av1_10bit"]);
    expect(win.hardwareAv1).toBe(false);
    expect(win.encoders).not.toContain("amf_av1");
  });

  it("reads HDR from the probe instead of assuming it is absent", () => {
    const facts = mediaFromProbe({
      streams: [{ codec_type: "video", codec_name: "hevc", color_transfer: "smpte2084" }, { codec_type: "audio" }, { codec_type: "subtitle" }],
      chapters: [{}],
      format: { format_name: "matroska", duration: "10" },
    });
    expect(facts).toMatchObject({ hdr: true, audio: 1, subtitles: 1, chapters: 1, videoCodec: "hevc" });
  });
});

function quiet() {
  return { format: "", duration: 1, videoCodec: "h264", audio: 0, subtitles: 0, chapters: 0, hdr: false };
}
