import { describe, expect, it } from "vitest"

import {
  SEED_RATIO_MIN,
  SEED_WALL_SECONDS,
  clientCompletionAt,
  decideSourceRetirement,
  emptyCompletion,
  evaluateSeedingGate,
  observeCompletion,
  type CompletionMemory,
  type RetirementInput,
  type SeedingCounters,
} from "@/lib/policies/source-retirement"

const HOUR = 3600

function counters(partial: Partial<SeedingCounters> = {}): SeedingCounters {
  return {
    ratio: partial.ratio === undefined ? 0.2 : partial.ratio,
    downloaded: partial.downloaded === undefined ? 1_000 : partial.downloaded,
    fresh: partial.fresh ?? true,
    error: partial.error ?? false,
  }
}

function verifiedInput(partial: Partial<RetirementInput> = {}): RetirementInput {
  const source = { path: "/library/show/episode.mkv", size: 100, sha256: "abc" }
  return {
    destination: "committed",
    destinationError: "none",
    verification: {
      containerOk: true,
      decodeOk: true,
      durationOk: true,
      tracksOk: true,
      presetAccepted: true,
      exitCode: 0,
      outputSmaller: true,
    },
    recordedSource: source,
    sourceNow: source,
    outputPath: "/library/out/episode.mkv",
    seeding: null,
    files: null,
    removeWholeTorrent: false,
    ...partial,
  }
}

describe("completion instant", () => {
  it("uses the client completion date and ignores added_on", () => {
    expect(clientCompletionAt({ completion_on: 500, added_on: 10 })).toBe(500)
    expect(clientCompletionAt({ completion_on: 0, added_on: 10 })).toBeNull()
    const first = observeCompletion(null, { hash: "aa", complete: true, clientCompletedAt: 500, now: 9_000 })
    expect(first.completedAt).toBe(500)
    expect(first.completedAtSource).toBe("client")
  })

  it("does not invent a completion date for a torrent that was already complete", () => {
    const memory = observeCompletion(null, { hash: "aa", complete: true, clientCompletedAt: null, now: 9_000 })
    expect(memory.completedAt).toBeNull()
  })

  it("stores an observed transition and then keeps that instant across restart and recheck", () => {
    let memory: CompletionMemory = observeCompletion(null, {
      hash: "aa",
      complete: false,
      clientCompletedAt: null,
      now: 1_000,
    })
    memory = observeCompletion(memory, { hash: "aa", complete: true, clientCompletedAt: null, now: 5_000 })
    expect(memory.completedAt).toBe(5_000)
    expect(memory.completedAtSource).toBe("observed")
    const restored = JSON.parse(JSON.stringify(memory)) as CompletionMemory
    const afterRestart = observeCompletion(restored, {
      hash: "aa",
      complete: true,
      clientCompletedAt: 50_000,
      now: 80_000,
    })
    expect(afterRestart.completedAt).toBe(5_000)
    expect(afterRestart).toEqual(restored)
  })
})

describe("72h wall clock from completion", () => {
  const completedAt = 1_700_000_000

  it("retains when ratio is under 3 and 72h have not elapsed", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 2.9 }),
      completedAt,
      now: completedAt + SEED_WALL_SECONDS - 1,
    })
    expect(gate.satisfied).toBe(false)
    expect(gate.blocked).toBe(false)
  })

  it("accepts ratio 3 before the clock, including a download that just finished", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: SEED_RATIO_MIN }),
      completedAt,
      now: completedAt,
    })
    expect(gate).toMatchObject({ satisfied: true, branch: "ratio", blocked: false })
  })

  it("accepts exactly 72h of wall clock while the torrent is under ratio 3", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 0.1 }),
      completedAt,
      now: completedAt + SEED_WALL_SECONDS,
    })
    expect(SEED_WALL_SECONDS).toBe(259_200)
    expect(gate).toMatchObject({ satisfied: true, branch: "time" })
  })

  it("counts pause and a stopped client because the clock is not active seeding time", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 0, downloaded: 1_000 }),
      completedAt,
      now: completedAt + 72 * HOUR,
    })
    expect(gate.satisfied).toBe(true)
    expect(gate.branch).toBe("time")
  })

  it("does not start the clock before completion and does not use a missing date as zero", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 0.2 }),
      completedAt: null,
      now: 10_000_000,
    })
    expect(gate.satisfied).toBe(false)
    expect(gate.blocked).toBe(false)
    expect(gate.branch).toBe("none")
  })

  it("retires on a known ratio of 3 when the completion date was never seen", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 3 }),
      completedAt: null,
      now: 10,
    })
    expect(gate).toMatchObject({ satisfied: true, branch: "ratio" })
  })

  it("blocks when both the ratio and the completion date are unknown", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: null, downloaded: null, fresh: false }),
      completedAt: null,
      now: 10,
    })
    expect(gate.blocked).toBe(true)
    expect(gate.satisfied).toBe(false)
  })

  it("does not read a stale ratio as below 3 while the clock is still short", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: null, downloaded: null, fresh: false }),
      completedAt,
      now: completedAt + 10,
    })
    expect(gate.satisfied).toBe(false)
    expect(gate.blocked).toBe(true)
    expect(gate.reason).toMatch(/недостоверен/)
  })

  it("does not treat a huge ratio on a zero-byte download as passing", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 999, downloaded: 0 }),
      completedAt: null,
      now: 10,
    })
    expect(gate.satisfied).toBe(false)
    expect(gate.blocked).toBe(true)
    expect(gate.reason).toMatch(/0 байт/)
  })

  it("keeps a zero-download torrent once 72h of wall clock have passed", () => {
    const gate = evaluateSeedingGate({
      counters: counters({ ratio: 999, downloaded: 0 }),
      completedAt,
      now: completedAt + SEED_WALL_SECONDS,
    })
    expect(gate).toMatchObject({ satisfied: true, branch: "time" })
  })
})

describe("source retirement", () => {
  const completedAt = 1_700_000_000

  it("always retains when the result is not verified, even at ratio 3 and after 72h", () => {
    const decision = decideSourceRetirement(verifiedInput({
      verification: {
        containerOk: true,
        decodeOk: true,
        durationOk: true,
        tracksOk: true,
        presetAccepted: false,
        exitCode: 0,
        outputSmaller: true,
      },
      seeding: { counters: counters({ ratio: 4 }), completedAt, now: completedAt + SEED_WALL_SECONDS },
    }))
    expect(decision.retire).toBe(false)
    expect(decision.deletePaths).toEqual([])
    expect(decision.reason).toMatch(/пресет/)
  })

  it("retains a verified encode until this torrent reaches ratio 3 or 72h", () => {
    const decision = decideSourceRetirement(verifiedInput({
      seeding: {
        counters: counters({ ratio: 2.9 }),
        completedAt,
        now: completedAt + 3 * HOUR,
      },
    }))
    expect(decision.retire).toBe(false)
    expect(decision.removeTorrentData).toBe(false)
  })

  it("retires one finished episode and leaves the unprocessed cover in the torrent", () => {
    const decision = decideSourceRetirement(verifiedInput({
      seeding: { counters: counters({ ratio: 0.2 }), completedAt, now: completedAt + SEED_WALL_SECONDS },
      files: [
        { path: "/library/show/episode.mkv", processed: true, heldByOtherTorrent: false },
        { path: "/library/show/cover.jpg", processed: false, heldByOtherTorrent: false },
      ],
    }))
    expect(decision.retire).toBe(true)
    expect(decision.deletePaths).toEqual(["/library/show/episode.mkv"])
    expect(decision.removeTorrentData).toBe(false)
  })

  it("retires only the processed file after 72h and does not remove the rest of the torrent", () => {
    const decision = decideSourceRetirement(verifiedInput({
      seeding: { counters: counters({ ratio: 0.2 }), completedAt, now: completedAt + SEED_WALL_SECONDS },
      files: [
        { path: "/library/show/episode.mkv", processed: true, heldByOtherTorrent: false },
        { path: "/library/show/cover.jpg", processed: false, heldByOtherTorrent: false },
      ],
      removeWholeTorrent: true,
    }))
    expect(decision.retire).toBe(false)
    expect(decision.removeTorrentData).toBe(false)
    expect(decision.reason).toMatch(/целиком/)
  })

  it("does not retire a file another active torrent still holds", () => {
    const decision = decideSourceRetirement(verifiedInput({
      seeding: { counters: counters({ ratio: 5 }), completedAt, now: completedAt },
      files: [{ path: "/library/show/episode.mkv", processed: true, heldByOtherTorrent: true }],
    }))
    expect(decision.retire).toBe(false)
    expect(decision.reason).toMatch(/другая раздача/)
  })

  it("refuses an in-place overwrite of the seeded file", () => {
    const source = { path: "/library/show/episode.mkv", size: 100, sha256: "abc" }
    const decision = decideSourceRetirement(verifiedInput({
      recordedSource: source,
      sourceNow: source,
      outputPath: source.path,
      seeding: { counters: counters({ ratio: 5 }), completedAt, now: completedAt },
    }))
    expect(decision.retire).toBe(false)
    expect(decision.blocked).toBe(true)
  })

  it("keeps the source when the destination is staging or the copy fails", () => {
    expect(decideSourceRetirement(verifiedInput({ destination: "staging" })).retire).toBe(false)
    expect(decideSourceRetirement(verifiedInput({ destinationError: "full" })).retire).toBe(false)
    expect(decideSourceRetirement(verifiedInput({ destinationError: "network" })).retire).toBe(false)
  })

  it("does not delete a changed file, a missing source's output, or a foreign path", () => {
    const changed = decideSourceRetirement(verifiedInput({
      sourceNow: { path: "/library/show/episode.mkv", size: 101, sha256: "other" },
    }))
    expect(changed.retire).toBe(false)
    const gone = decideSourceRetirement(verifiedInput({ sourceNow: null }))
    expect(gone.retire).toBe(false)
    expect(gone.deletePaths).toEqual([])
    const foreign = decideSourceRetirement(verifiedInput({
      sourceNow: { path: "/library/out/episode.mkv", size: 100, sha256: "abc" },
    }))
    expect(foreign.retire).toBe(false)
    expect(foreign.reason).toMatch(/результат/)
  })

  it("retires the matching source once ratio is 3 and the result is durable", () => {
    const decision = decideSourceRetirement(verifiedInput({
      seeding: { counters: counters({ ratio: 3 }), completedAt: null, now: 10 },
    }))
    expect(decision.retire).toBe(true)
    expect(decision.branch).toBe("ratio")
    expect(decision.deletePaths).toEqual(["/library/show/episode.mkv"])
    expect(decision.removeTorrentData).toBe(false)
  })

  it("removes whole torrent data only when every owned file is processed and the gate has passed", () => {
    const files = [
      { path: "/library/show/episode.mkv", processed: true, heldByOtherTorrent: false },
      { path: "/library/show/cover.jpg", processed: true, heldByOtherTorrent: false },
    ]
    const decision = decideSourceRetirement(verifiedInput({
      seeding: { counters: counters({ ratio: 0.4 }), completedAt, now: completedAt + SEED_WALL_SECONDS },
      files,
      removeWholeTorrent: true,
    }))
    expect(decision.retire).toBe(true)
    expect(decision.removeTorrentData).toBe(true)
    expect(decision.deletePaths).toEqual(["/library/show/episode.mkv"])
  })
})

describe("memory shape", () => {
  it("starts without a fabricated completion date", () => {
    expect(emptyCompletion("aa")).toEqual({
      hash: "aa",
      seenIncomplete: false,
      completedAt: null,
      completedAtSource: null,
    })
  })
})
