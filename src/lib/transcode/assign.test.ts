import { describe, expect, it } from "vitest"

import { assignEncodeJobs, type CodecProbe, type EncodeHost } from "@/lib/transcode/assign"

const macProbe: CodecProbe = {
  hardwareAv1: false,
  videoToolbox: { h264: true, hevc: true, av1: false },
  amf: null,
}

const pcProbe: CodecProbe = {
  hardwareAv1: true,
  videoToolbox: null,
  amf: { h264: true, hevc: true, av1: true },
}

const mac: EncodeHost = { id: "mac-mini", os: "darwin", slots: 1, probe: macProbe }
const pc: EncodeHost = { id: "windows-pc", os: "win32", slots: 2, probe: pcProbe }

describe("parallel HandBrake assignment", () => {
  it("leases different videos on PC and Mac in one pass and keeps a second PC slot", () => {
    const assigned = assignEncodeJobs(
      [
        { id: "a", codec: "hevc", allowSoftware: false },
        { id: "b", codec: "av1", allowSoftware: false },
        { id: "c", codec: "h264", allowSoftware: false },
      ],
      [mac, pc],
    )
    const hosts = assigned.filter((item) => item.state === "leased").map((item) => item.hostId)
    expect(new Set(hosts).size).toBe(2)
    expect(assigned.filter((item) => item.hostId === "windows-pc")).toHaveLength(2)
    expect(assigned.every((item) => item.codec === "hevc" || item.codec === "av1" || item.codec === "h264")).toBe(true)
    expect(assigned.find((item) => item.jobId === "b")?.codec).toBe("av1")
  })

  it("does not pretend a Mac M4 has hardware AV1 and does not swap AV1 for HEVC", () => {
    const blocked = assignEncodeJobs([{ id: "av1", codec: "av1", allowSoftware: false }], [mac])
    expect(blocked[0]).toMatchObject({ state: "blocked", codec: "av1", encoder: null })
    expect(blocked[0]?.reason).toMatch(/HEVC/)
    const software = assignEncodeJobs([{ id: "av1", codec: "av1", allowSoftware: true }], [mac])
    expect(software[0]).toMatchObject({ state: "leased", codec: "av1", encoder: "software", hostId: "mac-mini" })
  })

  it("keeps Linux on the encoders it actually listed and does not turn AV1 into HEVC", () => {
    const linux: EncodeHost = {
      id: "linux-local",
      os: "linux",
      slots: 2,
      probe: { hardwareAv1: false, videoToolbox: null, amf: null, encoders: ["x264", "x265"] },
    }
    const blocked = assignEncodeJobs([{ id: "av1", codec: "av1", allowSoftware: true }], [linux])
    expect(blocked[0]).toMatchObject({ state: "blocked", codec: "av1", encoder: null })
    expect(blocked[0]?.reason).toMatch(/HEVC/)
    const software = assignEncodeJobs(
      [{ id: "av1", codec: "av1", allowSoftware: true }],
      [{ ...linux, probe: { ...linux.probe, encoders: ["svt_av1", "x264"] } }],
    )
    expect(software[0]).toMatchObject({ state: "leased", encoder: "software", codec: "av1" })
  })

  it("uses the 1.11.1 encoder names and does not treat listed vce or missing vt_av1 as a hardware pass", () => {
    const mac: EncodeHost = {
      id: "mac",
      os: "linux",
      slots: 1,
      probe: { hardwareAv1: false, videoToolbox: null, amf: null, encoders: ["svt_av1", "svt_av1_10bit", "vt_h264", "vt_h265", "vt_h265_10bit", "vt_prores"] },
    };
    const pc: EncodeHost = {
      id: "pc",
      os: "linux",
      slots: 1,
      probe: { hardwareAv1: false, videoToolbox: null, amf: null, encoders: ["svt_av1", "svt_av1_10bit", "vce_av1", "vce_av1_10bit", "vce_h264", "vce_h265", "vce_h265_10bit"] },
    };
    expect(assignEncodeJobs([{ id: "a", codec: "av1", allowSoftware: true }], [mac, pc]).map((item) => item.encoder)).toEqual(["software"]);
    const noAv1: EncodeHost = { ...mac, probe: { ...mac.probe, encoders: ["vt_h264", "vt_h265", "x264"] } };
    expect(assignEncodeJobs([{ id: "a", codec: "av1", allowSoftware: true }], [noAv1])[0]).toMatchObject({ state: "blocked", encoder: null });
  });

  it("does not give a leased job to a second worker", () => {
    const again = assignEncodeJobs([{ id: "a", codec: "hevc", allowSoftware: true }], [pc], new Set(["a"]))
    expect(again[0]?.state).toBe("blocked")
  })
})
