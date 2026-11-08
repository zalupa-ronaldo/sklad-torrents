/**
 * One shared encode queue. PC and Mac take different jobs in the same pass.
 * The encode program is HandBrakeCLI. This function does not start it.
 * A requested AV1 job is never rewritten to HEVC.
 * Hardware AV1 is used only when a probe says the encoder exists.
 */

export type EncodeCodec = "av1" | "hevc" | "h264"

export interface CodecProbe {
  /** Null means this host was not probed. That is not a claim that AV1 hardware exists. */
  hardwareAv1: boolean | null
  videoToolbox: { h264: boolean; hevc: boolean; av1: boolean } | null
  amf: { h264: boolean; hevc: boolean; av1: boolean } | null
  /** Names from this machine's HandBrake `--help`. Absent means the caller did not pass a list. */
  encoders?: readonly string[]
}

export interface EncodeHost {
  id: string
  os: "win32" | "darwin" | "linux"
  slots: number
  probe: CodecProbe
}

export interface EncodeRequest {
  id: string
  codec: EncodeCodec
  /** Software AV1 stays AV1 and is labeled software. It does not become HEVC. */
  allowSoftware: boolean
}

export interface EncodeAssignment {
  jobId: string
  hostId: string | null
  codec: EncodeCodec
  encoder: "hardware" | "software" | null
  state: "leased" | "blocked"
  reason: string
}

export function assignEncodeJobs(
  jobs: readonly EncodeRequest[],
  hosts: readonly EncodeHost[],
  held: ReadonlySet<string> = new Set(),
): EncodeAssignment[] {
  const free = new Map(hosts.map((host) => [host.id, Math.max(0, host.slots)]))
  const out: EncodeAssignment[] = []
  for (const job of jobs) {
    if (held.has(job.id)) {
      out.push({ jobId: job.id, hostId: null, codec: job.codec, encoder: null, state: "blocked", reason: "Задание уже занято другим исполнителем." })
      continue
    }
    const host = hosts.find((item) => (free.get(item.id) ?? 0) > 0 && encoderFor(item, job) != null)
    const choice = host ? encoderFor(host, job) : null
    if (!host || !choice) {
      out.push({
        jobId: job.id,
        hostId: null,
        codec: job.codec,
        encoder: null,
        state: "blocked",
        reason: job.codec === "av1"
          ? "Аппаратного AV1 на свободном хосте нет. Подмена на HEVC не делается."
          : "Нет свободного слота с подходящим кодеком HandBrake.",
      })
      continue
    }
    free.set(host.id, (free.get(host.id) ?? 0) - 1)
    out.push({
      jobId: job.id,
      hostId: host.id,
      codec: job.codec,
      encoder: choice,
      state: "leased",
      reason: choice === "software"
        ? "AV1 остаётся AV1 и пойдёт программно. Это не аппаратный кодировщик и не обещание двойной скорости."
        : "Слот HandBrake занят на этом хосте. Другой ролик может идти на другом хосте одновременно.",
    })
  }
  return out
}

function encoderFor(host: EncodeHost, job: EncodeRequest): "hardware" | "software" | null {
  if (host.os === "linux") return linuxEncoder(host, job)
  if (job.codec === "av1") {
    if (host.probe.hardwareAv1 === true) return "hardware"
    if (host.os === "darwin" && host.probe.videoToolbox?.av1 === true) return "hardware"
    if (host.os === "win32" && host.probe.amf?.av1 === true) return "hardware"
    return job.allowSoftware ? "software" : null
  }
  const table = host.os === "darwin" ? host.probe.videoToolbox : host.probe.amf
  if (table?.[job.codec] === true) return "hardware"
  return job.allowSoftware ? "software" : null
}

const HARDWARE_AV1 = /^(nvenc_av1|qsv_av1|vt_av1|vce_av1|amf_av1)$/

function linuxEncoder(host: EncodeHost, job: EncodeRequest): "hardware" | "software" | null {
  const names = host.probe.encoders
  const listed = (name: string) => !names || names.includes(name)
  if (job.codec === "av1") {
    const hardwareListed = !names || names.some((name) => HARDWARE_AV1.test(name))
    if (host.probe.hardwareAv1 === true && hardwareListed) return "hardware"
    if (!listed("svt_av1") && !listed("svt_av1_10bit")) return null
    return job.allowSoftware ? "software" : null
  }
  const software = job.codec === "hevc" ? "x265" : "x264"
  if (!listed(software)) return null
  return job.allowSoftware ? "software" : null
}
