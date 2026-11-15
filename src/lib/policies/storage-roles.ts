/**
 * Confirmed disk roles. Paths for the game pool, staging and reserve are not chosen here.
 * Nothing in this module moves or deletes a file.
 *
 * A prepared game stays on C: until the user explicitly removes it from the pool.
 */

export const MAC_DATA_UUID = "f21d84d5-4718-4971-a377-d9ecba00e401"
export const MAC_VAULT_UUID = "54c64f37-629a-410e-b506-92969ef32eec"

export const GAME_POOL_PIN = "until-explicit-remove" as const

/** Not agreed yet. Callers must not substitute a real directory. */
export const UNCONFIGURED_PATHS = {
  gamePool: null,
  staging: null,
  reserve: null,
} as const

export type StorageRole = "game-pool" | "scratch" | "cold-archive" | "forbidden" | "virtual" | "unconfigured"

export interface VolumeRef {
  os: "darwin" | "win32"
  letter?: string | null
  volumeUuid?: string | null
}

const FORBIDDEN = new Set(["E", "Z"])

export function normalizeUuid(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

export function storageRole(volume: VolumeRef): StorageRole {
  const uuid = normalizeUuid(volume.volumeUuid)
  if (uuid === MAC_DATA_UUID || uuid === MAC_VAULT_UUID) return "scratch"
  const letter = String(volume.letter ?? "").trim().replace(":", "").toUpperCase()
  if (volume.os === "win32" && FORBIDDEN.has(letter)) return "forbidden"
  if (volume.os === "win32" && letter === "F") return "virtual"
  if (volume.os === "win32" && letter === "C") return "game-pool"
  if (volume.os === "win32" && letter) return "cold-archive"
  return "unconfigured"
}

export function preferredVideoScratch(): readonly { volumeUuid: string; role: "scratch" }[] {
  return [
    { volumeUuid: MAC_DATA_UUID, role: "scratch" },
    { volumeUuid: MAC_VAULT_UUID, role: "scratch" },
  ]
}

export type EvictTrigger = "lru" | "idle" | "session-exit" | "space-pressure" | "game-exit" | "video-scratch"

export interface EvictDecision {
  evict: false
  pin: typeof GAME_POOL_PIN
  reason: string
}

/** No automatic victim. Every listed trigger keeps the prepared game. */
export function evictPreparedGame(_trigger: EvictTrigger): EvictDecision {
  return {
    evict: false,
    pin: GAME_POOL_PIN,
    reason: "Подготовленная игра остаётся на C:, пока её явно не уберут из пула.",
  }
}

export interface SpaceDecision {
  ok: boolean
  blocked: "insufficient-space" | "space-unknown" | null
  suggestManualRemoval: boolean
  victim: null
}

export function gamePoolSpace(input: { freeBytes: number | null; neededBytes: number }): SpaceDecision {
  if (input.freeBytes == null || !Number.isFinite(input.freeBytes)) {
    return { ok: false, blocked: "space-unknown", suggestManualRemoval: false, victim: null }
  }
  if (input.freeBytes < input.neededBytes) {
    return { ok: false, blocked: "insufficient-space", suggestManualRemoval: true, victim: null }
  }
  return { ok: true, blocked: null, suggestManualRemoval: false, victim: null }
}

export interface AdoptDecision {
  adopt: false
  reason: string
}

export function adoptExistingGame(): AdoptDecision {
  return { adopt: false, reason: "Уже лежащие на C: игры в пул не зачисляются и не удаляются." }
}

export interface RemoveDecision {
  clean: boolean
  blocked: "cold-copy-missing" | "cold-copy-unverified" | "only-copy" | null
  reason: string
}

/** Manual removal still refuses to wipe C: when that copy is the only one. */
export function removeFromGamePool(coldCopy: "verified" | "missing" | "unverified" | "only-copy"): RemoveDecision {
  if (coldCopy === "verified") {
    return { clean: true, blocked: null, reason: "Холодная копия проверена. Копию на C: можно убрать по этой явной команде." }
  }
  if (coldCopy === "only-copy") {
    return { clean: false, blocked: "only-copy", reason: "Это единственная копия. С C: она не стирается." }
  }
  if (coldCopy === "unverified") {
    return { clean: false, blocked: "cold-copy-unverified", reason: "Холодная копия ещё не проверена. C: не очищается." }
  }
  return { clean: false, blocked: "cold-copy-missing", reason: "Холодной копии нет. C: не очищается." }
}

export interface ScratchCleanup {
  delete: boolean
  reason: string
}

export function cleanupScratch(input: {
  owner: "this-job" | "user" | "game-pool"
  verified: boolean
  targetCommitted: boolean
}): ScratchCleanup {
  if (input.owner !== "this-job") {
    return { delete: false, reason: "Чужие файлы и игры со scratch не удаляются." }
  }
  if (!input.verified || !input.targetCommitted) {
    return { delete: false, reason: "Scratch остаётся, пока результат не проверен и не записан на постоянную цель." }
  }
  return { delete: true, reason: "Можно убрать только свой проверенный файл задания. Игры на C: это не затрагивает." }
}
