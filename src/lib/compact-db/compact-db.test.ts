import { describe, expect, it } from "vitest"

import {
  COMPACT_DB_URL,
  adviseCompression,
  cacheFromText,
  emptyCompactCache,
  lookupCompactResult,
  refreshCompactDatabase,
  type CompactLookup,
} from "@/lib/compact-db/database"
import { decideGameCompression } from "@/lib/compact-db/game-root"

const FIXTURE = JSON.stringify([
  {
    SteamID: 424242,
    GameName: "Fixture Game",
    Confidence: 2,
    CompressionResults: [
      { CompType: 0, BeforeBytes: 1000, AfterBytes: 900, TotalResults: 4 },
      { CompType: 3, BeforeBytes: 1000, AfterBytes: 1100, TotalResults: 2 },
    ],
  },
  {
    SteamID: 424243,
    GameName: "Fixture Zero",
    Confidence: 1,
    CompressionResults: [{ CompType: 2, BeforeBytes: 0, AfterBytes: 0, TotalResults: 1 }],
  },
])

function hit(algorithm: "XPRESS4K" | "LZX" | "XPRESS16K", status: CompactLookup["status"] = "hit"): CompactLookup {
  const cache = cacheFromText(FIXTURE, "2026-11-08T12:00:00.000Z")
  return lookupCompactResult(cache, 424242, algorithm, status === "stale" ? { nowMs: Date.parse("2026-11-09T12:00:00.000Z"), maxAgeMs: 60_000 } : undefined)
}

describe("CompactGUI database", () => {
  it("parses the published array and keeps savings unknown when before-bytes are zero", () => {
    const cache = cacheFromText(FIXTURE, "2026-11-08T12:00:00.000Z")
    const row = lookupCompactResult(cache, 424242, "XPRESS4K")
    expect(row.status).toBe("hit")
    if (row.status === "hit") {
      expect(row.sampleCount).toBe(4)
      expect(row.savings).toBeCloseTo(0.1)
      expect(row.source).toBe(COMPACT_DB_URL)
      expect(row.updatedAt).toBe("2026-11-08T12:00:00.000Z")
    }
    const zero = lookupCompactResult(cache, 424243, "XPRESS16K")
    expect(zero.status).toBe("hit")
    if (zero.status === "hit") expect(zero.savings).toBeNull()
  })

  it("keeps a bad cache from replacing a valid one and does not call the catalog", async () => {
    const previous = cacheFromText(FIXTURE, "2026-11-08T12:00:00.000Z")
    const broken = await refreshCompactDatabase({
      previous,
      nowIso: "2026-11-08T13:00:00.000Z",
      fetchImpl: async (url) => {
        expect(url).toBe(COMPACT_DB_URL)
        return new Response("not-json", { status: 200 })
      },
    })
    expect(broken.error).toMatch(/не разобран/)
    expect(broken.cache.games).toHaveLength(2)
    const offline = await refreshCompactDatabase({
      previous,
      nowIso: "2026-11-08T13:00:00.000Z",
      fetchImpl: async () => {
        throw new Error("network down")
      },
    })
    expect(offline.cache).toBe(previous)
    expect(cacheFromText("{", null).valid).toBe(false)
    expect(lookupCompactResult(emptyCompactCache(), 424242, "LZX").status).toBe("unavailable")
  })

  it("skips negative or low gain, holds unknown and stale rows, and does not borrow another algorithm", () => {
    expect(adviseCompression({
      lookup: hit("LZX"),
      requested: "LZX",
      alreadyAlgorithm: null,
      minSavings: null,
      manualOverride: false,
    }).action).toBe("skip")
    expect(adviseCompression({
      lookup: hit("XPRESS4K"),
      requested: "XPRESS4K",
      alreadyAlgorithm: null,
      minSavings: 0.2,
      manualOverride: false,
    }).action).toBe("skip")
    expect(adviseCompression({
      lookup: lookupCompactResult(cacheFromText(FIXTURE, "2026-11-08T12:00:00.000Z"), 424242, "XPRESS8K"),
      requested: "XPRESS8K",
      alreadyAlgorithm: null,
      minSavings: null,
      manualOverride: false,
    }).action).toBe("hold")
    expect(adviseCompression({
      lookup: hit("XPRESS4K", "stale"),
      requested: "XPRESS4K",
      alreadyAlgorithm: null,
      minSavings: null,
      manualOverride: false,
    }).action).toBe("hold")
    expect(adviseCompression({
      lookup: hit("XPRESS4K"),
      requested: "XPRESS4K",
      alreadyAlgorithm: "XPRESS4K",
      minSavings: null,
      manualOverride: false,
    }).action).toBe("skip")
  })
})

describe("whole game root", () => {
  const lookup = lookupCompactResult(cacheFromText(FIXTURE, "2026-11-08T12:00:00.000Z"), 424242, "XPRESS4K")
  const base = {
    identified: true,
    steamAppId: 424242,
    kind: "game-root" as const,
    path: "D:\\Cold\\Fixture",
    os: "win32" as const,
    filesystem: "NTFS",
    letter: "D",
    escapes: [],
    lookup,
    requested: "XPRESS4K" as const,
    alreadyAlgorithm: null,
    minSavings: null,
    manualOverride: false,
  }

  it("accepts one verified game root on a cold NTFS disk", () => {
    const decision = decideGameCompression(base)
    expect(decision.accept).toBe(true)
    expect(decision.jobCount).toBe(1)
    expect(decision.role).toBe("cold-archive")
  })

  it("rejects a disk root, a Games container, a file, a subfolder, and an unidentified root", () => {
    expect(decideGameCompression({ ...base, kind: "volume-root", path: "D:\\" }).accept).toBe(false)
    expect(decideGameCompression({ ...base, kind: "games-container", path: "D:\\Games" }).accept).toBe(false)
    expect(decideGameCompression({ ...base, kind: "file", path: "D:\\Cold\\Fixture\\game.exe" }).accept).toBe(false)
    expect(decideGameCompression({ ...base, kind: "subfolder", path: "D:\\Cold\\Fixture\\bin" }).accept).toBe(false)
    expect(decideGameCompression({ ...base, identified: false, steamAppId: null }).reason).toMatch(/exe/)
  })

  it("stops before E or Z and does not send compression to Mac", () => {
    expect(decideGameCompression({ ...base, escapes: ["E:\\linked"] }).accept).toBe(false)
    expect(decideGameCompression({ ...base, letter: "Z", path: "Z:\\Fixture" }).role).toBe("forbidden")
    expect(decideGameCompression({ ...base, os: "darwin", filesystem: "APFS", letter: null, path: "/Volumes/vault/Fixture" }).reason).toMatch(/APFS/)
  })
})
