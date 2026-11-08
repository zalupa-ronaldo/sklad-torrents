/**
 * Community compression results published by CompactGUI.
 * The program is GPL-3.0, copyright Iridium IO. This module does not copy that source.
 * It reads the JSON file the project publishes on the database branch.
 * The file has no per-game timestamp. updatedAt is when we fetched the file.
 * A fetch sends no catalog and no local file names.
 */

export const COMPACT_DB_URL = "https://raw.githubusercontent.com/IridiumIO/CompactGUI/database/database.json"

/** CompType in database.json, matching CompressionMode in CompactGUI.Core. */
export const COMPACT_DB_ALGORITHMS = ["XPRESS4K", "XPRESS8K", "XPRESS16K", "LZX"] as const
export type CompactDbAlgorithm = (typeof COMPACT_DB_ALGORITHMS)[number]

const COMP_TYPE: Record<number, CompactDbAlgorithm> = {
  0: "XPRESS4K",
  1: "XPRESS8K",
  2: "XPRESS16K",
  3: "LZX",
}

export interface CompactDbSample {
  algorithm: CompactDbAlgorithm
  beforeBytes: number
  afterBytes: number
  /** Community submissions for this algorithm. */
  sampleCount: number
  /** Fraction saved, (before-after)/before. Null when the bytes cannot support it. */
  savings: number | null
}

export interface CompactDbGame {
  steamAppId: number
  confidence: number | null
  algorithms: Partial<Record<CompactDbAlgorithm, CompactDbSample>>
}

export interface CompactDbCache {
  source: string
  fetchedAt: string | null
  valid: boolean
  games: CompactDbGame[]
}

export type CompactLookup =
  | {
      status: "hit" | "stale"
      steamAppId: number
      algorithm: CompactDbAlgorithm
      beforeBytes: number
      afterBytes: number
      sampleCount: number
      savings: number | null
      confidence: number | null
      source: string
      updatedAt: string | null
    }
  | { status: "unknown" | "unavailable"; steamAppId: number; algorithm: CompactDbAlgorithm; source: string }

export function emptyCompactCache(): CompactDbCache {
  return { source: COMPACT_DB_URL, fetchedAt: null, valid: false, games: [] }
}

export function parseCompactDatabase(payload: unknown): { ok: true; games: CompactDbGame[] } | { ok: false; reason: string } {
  if (!Array.isArray(payload)) return { ok: false, reason: "База CompactGUI должна быть JSON-массивом." }
  const games: CompactDbGame[] = []
  for (const row of payload) {
    if (!row || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    const steamAppId = finiteId(record.SteamID)
    if (steamAppId == null) continue
    const algorithms: CompactDbGame["algorithms"] = {}
    const results = Array.isArray(record.CompressionResults) ? record.CompressionResults : []
    for (const item of results) {
      if (!item || typeof item !== "object") continue
      const result = item as Record<string, unknown>
      const algorithm = COMP_TYPE[Number(result.CompType)]
      const beforeBytes = finiteBytes(result.BeforeBytes)
      const afterBytes = finiteBytes(result.AfterBytes)
      const sampleCount = finiteBytes(result.TotalResults)
      if (!algorithm || beforeBytes == null || afterBytes == null || sampleCount == null) continue
      algorithms[algorithm] = {
        algorithm,
        beforeBytes,
        afterBytes,
        sampleCount,
        savings: beforeBytes > 0 ? (beforeBytes - afterBytes) / beforeBytes : null,
      }
    }
    const confidence = finiteBytes(record.Confidence)
    games.push({ steamAppId, confidence, algorithms })
  }
  return { ok: true, games }
}

export function cacheFromText(text: string, fetchedAt: string | null): CompactDbCache {
  try {
    const parsed = parseCompactDatabase(JSON.parse(text) as unknown)
    if (!parsed.ok) return { ...emptyCompactCache(), fetchedAt }
    return { source: COMPACT_DB_URL, fetchedAt, valid: true, games: parsed.games }
  } catch {
    return { ...emptyCompactCache(), fetchedAt }
  }
}

export function isCacheStale(cache: CompactDbCache, nowMs: number, maxAgeMs: number): boolean {
  if (!cache.valid || !cache.fetchedAt) return true
  const fetched = Date.parse(cache.fetchedAt)
  if (!Number.isFinite(fetched)) return true
  return nowMs - fetched > maxAgeMs
}

export function lookupCompactResult(
  cache: CompactDbCache,
  steamAppId: number,
  algorithm: CompactDbAlgorithm,
  options?: { nowMs?: number; maxAgeMs?: number },
): CompactLookup {
  const base = { steamAppId, algorithm, source: COMPACT_DB_URL }
  if (!cache.valid) return { ...base, status: "unavailable" }
  const game = cache.games.find((item) => item.steamAppId === steamAppId)
  const sample = game?.algorithms[algorithm]
  if (!game || !sample) return { ...base, status: "unknown" }
  const stale = options?.nowMs != null && options.maxAgeMs != null && isCacheStale(cache, options.nowMs, options.maxAgeMs)
  return {
    ...base,
    status: stale ? "stale" : "hit",
    beforeBytes: sample.beforeBytes,
    afterBytes: sample.afterBytes,
    sampleCount: sample.sampleCount,
    savings: sample.savings,
    confidence: game.confidence,
    updatedAt: cache.fetchedAt,
  }
}

export type CompressionAdvice =
  | { action: "eligible"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "hold"; reason: string }
  | { action: "manual-override"; reason: string }

/**
 * minSavings is a local setting. It is not a figure from the CompactGUI database.
 * Null means only a non-positive saving is a skip. Unknown stays unknown, never zero.
 */
export function adviseCompression(input: {
  lookup: CompactLookup
  requested: CompactDbAlgorithm
  alreadyAlgorithm: CompactDbAlgorithm | null
  minSavings: number | null
  manualOverride: boolean
}): CompressionAdvice {
  if (input.alreadyAlgorithm === input.requested) {
    return { action: "skip", reason: "Эта папка уже сжата тем же алгоритмом. Повторно не сжимается." }
  }
  if (input.lookup.status === "unavailable") {
    return holdOrOverride(input.manualOverride, "База CompactGUI недоступна или повреждена. Каталог не изменён, полное сжатие не запускается.")
  }
  if (input.lookup.status === "unknown") {
    return holdOrOverride(input.manualOverride, "Для этого Steam app id и алгоритма в базе нет строки. Неизвестная экономия не считается нулём, полное сжатие не запускается.")
  }
  if (input.lookup.status === "stale") {
    return holdOrOverride(input.manualOverride, "Кэш базы устарел. Старые цифры не разрешают автоматическое сжатие.")
  }
  if (input.lookup.status !== "hit") {
    return holdOrOverride(input.manualOverride, "В базе нет результата для запрошенного алгоритма. Чужой алгоритм не подставляется.")
  }
  const savings = input.lookup.savings
  if (savings == null) {
    return holdOrOverride(input.manualOverride, "В строке базы нет пригодных байт до и после. Экономия неизвестна.")
  }
  if (savings <= 0) {
    return { action: "skip", reason: "По базе этот алгоритм не уменьшает размер или увеличивает его. Сжатие пропускается." }
  }
  if (input.minSavings != null && savings < input.minSavings) {
    return { action: "skip", reason: "Экономия ниже заданного местного порога. Это не порог из базы CompactGUI." }
  }
  return { action: "eligible", reason: "В свежей базе для этого алгоритма есть положительная экономия." }
}

function holdOrOverride(manualOverride: boolean, reason: string): CompressionAdvice {
  if (!manualOverride) return { action: "hold", reason }
  return {
    action: "manual-override",
    reason: `${reason} Ручное разрешение не запускает сжатие всего дерева само.`,
  }
}

export async function refreshCompactDatabase(input: {
  previous: CompactDbCache | null
  fetchImpl: typeof fetch
  nowIso: string
}): Promise<{ cache: CompactDbCache; error: string | null }> {
  const previous = input.previous?.valid ? input.previous : emptyCompactCache()
  try {
    const response = await input.fetchImpl(COMPACT_DB_URL, { method: "GET" })
    if (!response.ok) throw new Error(`http ${response.status}`)
    const text = await response.text()
    const next = cacheFromText(text, input.nowIso)
    if (!next.valid) return { cache: previous, error: "Ответ базы CompactGUI не разобран. Прежний кэш сохранён." }
    return { cache: next, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Сеть базы CompactGUI недоступна."
    return { cache: previous, error: message }
  }
}

function finiteId(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(number) || number <= 0) return null
  return number
}

function finiteBytes(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return number
}
