/**
 * One compression job is one identified game root and the whole tree under it.
 * NTFS still compresses files inside that operation. The account is the game.
 * An unclear root is refused. An executable name is not identification.
 */

import type { CompactDbAlgorithm, CompactLookup, CompressionAdvice } from "@/lib/compact-db/database"
import { adviseCompression } from "@/lib/compact-db/database"
import { storageRole, type StorageRole } from "@/lib/policies/storage-roles"

export type GameRootKind = "volume-root" | "games-container" | "file" | "subfolder" | "game-root"

export interface GameCompressionInput {
  identified: boolean
  steamAppId: number | null
  kind: GameRootKind
  /** Absolute Windows path of the candidate. Not used to guess the game. */
  path: string
  os: "win32" | "darwin"
  filesystem: string
  letter: string | null
  volumeUuid?: string | null
  /** Paths the walk would leave the root or another volume. Refused before any open. */
  escapes: readonly string[]
  lookup: CompactLookup
  requested: CompactDbAlgorithm
  alreadyAlgorithm: CompactDbAlgorithm | null
  minSavings: number | null
  manualOverride: boolean
}

export interface GameCompressionDecision {
  accept: boolean
  jobCount: 0 | 1
  role: StorageRole
  advice: CompressionAdvice | null
  reason: string
}

const VOLUME_ROOT = /^[A-Za-z]:\\?$/
const GAMES_CONTAINER = /^[A-Za-z]:\\Games\\?$/i

export function decideGameCompression(input: GameCompressionInput): GameCompressionDecision {
  const letter = String(input.letter ?? "").replace(":", "").toUpperCase()
  const role = storageRole({ os: input.os, letter, volumeUuid: input.volumeUuid })
  const refuse = (reason: string): GameCompressionDecision => ({ accept: false, jobCount: 0, role, advice: null, reason })

  if (input.os !== "win32" || !/ntfs/i.test(input.filesystem)) {
    return refuse("Сжатие CompactGUI только на NTFS Windows. Mac и APFS не используются, MFT там не ищется.")
  }
  if (role === "forbidden") return refuse("Тома E и Z для сжатия закрыты. Обход туда не начинается.")
  if (role === "virtual") return refuse("F — виртуальный Alcohol, не цель сжатия.")
  if (role !== "game-pool" && role !== "cold-archive") {
    return refuse("Сжимать игру можно на холодном HDD или в пуле C:. Этот том для этого не назначен.")
  }
  if (!input.identified || input.steamAppId == null) {
    return refuse("Корень игры не распознан. Имя exe его не заменяет, сжатие не начинается.")
  }
  if (input.kind === "volume-root" || VOLUME_ROOT.test(input.path)) {
    return refuse("Корень диска не сжимается. Нужна корневая папка одной игры.")
  }
  if (input.kind === "games-container" || GAMES_CONTAINER.test(input.path)) {
    return refuse("Общая папка Games не сжимается. Нужна корневая папка одной игры.")
  }
  if (input.kind === "file") return refuse("Отдельный файл не сжимается. Учёт идёт на всю игру.")
  if (input.kind === "subfolder") return refuse("Подпапка игры не сжимается отдельно. Берётся корень игры целиком.")
  if (input.kind !== "game-root") return refuse("Корень игры не подтверждён.")
  if (input.escapes.length > 0) {
    return refuse("Внутри корня есть выход наружу или на запрещённый том. Такие ссылки не обходятся.")
  }

  const advice = adviseCompression({
    lookup: input.lookup,
    requested: input.requested,
    alreadyAlgorithm: input.alreadyAlgorithm,
    minSavings: input.minSavings,
    manualOverride: input.manualOverride,
  })
  if (advice.action !== "eligible" && advice.action !== "manual-override") {
    return { accept: false, jobCount: 0, role, advice, reason: advice.reason }
  }
  return { accept: true, jobCount: 1, role, advice, reason: advice.reason }
}
