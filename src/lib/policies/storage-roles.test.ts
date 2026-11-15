import { describe, expect, it } from "vitest"

import {
  GAME_POOL_PIN,
  MAC_DATA_UUID,
  MAC_VAULT_UUID,
  UNCONFIGURED_PATHS,
  adoptExistingGame,
  cleanupScratch,
  evictPreparedGame,
  gamePoolSpace,
  preferredVideoScratch,
  removeFromGamePool,
  storageRole,
  type EvictTrigger,
} from "@/lib/policies/storage-roles"

describe("disk roles", () => {
  it("keeps both Mac SSDs as scratch and not as a permanent store", () => {
    expect(storageRole({ os: "darwin", volumeUuid: "F21D84D5-4718-4971-A377-D9ECBA00E401" })).toBe("scratch")
    expect(storageRole({ os: "darwin", volumeUuid: MAC_VAULT_UUID })).toBe("scratch")
    expect(storageRole({ os: "darwin", volumeUuid: "11111111-1111-4111-8111-111111111111" })).toBe("unconfigured")
    expect(preferredVideoScratch().map((item) => item.volumeUuid)).toEqual([MAC_DATA_UUID, MAC_VAULT_UUID])
    expect(preferredVideoScratch().some((item) => item.role === "scratch")).toBe(true)
  })

  it("treats C: as the game pool, other PC disks as cold HDD, and refuses E, Z and Alcohol F", () => {
    expect(storageRole({ os: "win32", letter: "C" })).toBe("game-pool")
    expect(storageRole({ os: "win32", letter: "D" })).toBe("cold-archive")
    expect(storageRole({ os: "win32", letter: "S:" })).toBe("cold-archive")
    expect(storageRole({ os: "win32", letter: "E" })).toBe("forbidden")
    expect(storageRole({ os: "win32", letter: "Z" })).toBe("forbidden")
    expect(storageRole({ os: "win32", letter: "F" })).toBe("virtual")
    expect(storageRole({ os: "win32" })).toBe("unconfigured")
  })

  it("does not invent pool, staging or reserve paths", () => {
    expect(UNCONFIGURED_PATHS).toEqual({ gamePool: null, staging: null, reserve: null })
  })
})

describe("pin until explicit remove", () => {
  const triggers: EvictTrigger[] = ["lru", "idle", "session-exit", "space-pressure", "game-exit", "video-scratch"]

  it("does not evict a prepared game for any automatic reason", () => {
    for (const trigger of triggers) {
      expect(evictPreparedGame(trigger)).toEqual({
        evict: false,
        pin: GAME_POOL_PIN,
        reason: expect.stringMatching(/пока её явно не уберут/),
      })
    }
  })

  it("blocks on low or unknown space and does not choose a victim", () => {
    expect(gamePoolSpace({ freeBytes: 10, neededBytes: 50 })).toEqual({
      ok: false,
      blocked: "insufficient-space",
      suggestManualRemoval: true,
      victim: null,
    })
    expect(gamePoolSpace({ freeBytes: null, neededBytes: 50 }).victim).toBeNull()
    expect(gamePoolSpace({ freeBytes: null, neededBytes: 50 }).blocked).toBe("space-unknown")
    expect(gamePoolSpace({ freeBytes: 80, neededBytes: 50 }).ok).toBe(true)
  })

  it("does not adopt games already on C:", () => {
    expect(adoptExistingGame().adopt).toBe(false)
  })

  it("cleans C: only after a verified cold copy and never when that copy is the only one", () => {
    expect(removeFromGamePool("verified").clean).toBe(true)
    expect(removeFromGamePool("missing")).toMatchObject({ clean: false, blocked: "cold-copy-missing" })
    expect(removeFromGamePool("unverified")).toMatchObject({ clean: false, blocked: "cold-copy-unverified" })
    expect(removeFromGamePool("only-copy")).toMatchObject({ clean: false, blocked: "only-copy" })
  })

  it("lets Mac scratch delete only its own committed job file", () => {
    expect(cleanupScratch({ owner: "this-job", verified: true, targetCommitted: true }).delete).toBe(true)
    expect(cleanupScratch({ owner: "this-job", verified: true, targetCommitted: false }).delete).toBe(false)
    expect(cleanupScratch({ owner: "user", verified: true, targetCommitted: true }).delete).toBe(false)
    expect(cleanupScratch({ owner: "game-pool", verified: true, targetCommitted: true }).delete).toBe(false)
    expect(cleanupScratch({ owner: "game-pool", verified: true, targetCommitted: true }).reason).toMatch(/игры/)
  })
})
