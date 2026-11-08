/**
 * Product rule for retiring a processed source.
 * The encode pipeline does not call this yet. Nothing here deletes a file.
 *
 * Seeding time is wall-clock from the moment the download finished:
 * now >= completedAt + 72h. Pauses, idle, and a stopped client are included.
 * It is not qBittorrent's accumulated active seeding_time.
 * added_on / started_on are not a start. A missing completion date is not invented.
 */

export const SEED_RATIO_MIN = 3
export const SEED_WALL_SECONDS = 72 * 60 * 60

export type CompletionSource = "client" | "observed"

export interface CompletionMemory {
  hash: string
  /** Set while we have actually seen this torrent still downloading. */
  seenIncomplete: boolean
  /** Unix seconds. Stable once set. Reconnect and recheck must not move it. */
  completedAt: number | null
  completedAtSource: CompletionSource | null
}

export interface CompletionObservation {
  hash: string
  complete: boolean
  /** Client completion_on, unix seconds. 0 and null mean the client did not say. */
  clientCompletedAt: number | null
  now: number
}

export interface SeedingCounters {
  /** Client ratio field. Null means not reported. Never derive this from file size. */
  ratio: number | null
  /** Client downloaded byte counter. Null means unknown. 0 is a real zero, not an infinite ratio. */
  downloaded: number | null
  fresh: boolean
  error: boolean
}

export interface SeedingGate {
  /** True when ratio >= 3 with a real download, or 72h of wall clock since completion. */
  satisfied: boolean
  blocked: boolean
  branch: "ratio" | "time" | "none"
  reason: string
}

export interface VerificationReport {
  containerOk: boolean
  decodeOk: boolean
  durationOk: boolean
  tracksOk: boolean
  /** A recorded preset acceptance. Process exit 0 is not this flag. */
  presetAccepted: boolean
  exitCode: number | null
  outputSmaller: boolean | null
}

export interface FileIdentity {
  path: string
  size: number
  sha256: string
}

export interface TorrentFileRef {
  path: string
  /** This file itself has a verified durable output. */
  processed: boolean
  /** Another live torrent still points at the same path and has not passed the seeding gate. */
  heldByOtherTorrent: boolean
}

export interface RetirementInput {
  destination: "missing" | "staging" | "committed"
  destinationError: "none" | "full" | "network"
  verification: VerificationReport | null
  recordedSource: FileIdentity
  sourceNow: FileIdentity | null
  outputPath: string
  seeding: { counters: SeedingCounters; completedAt: number | null; now: number } | null
  files: readonly TorrentFileRef[] | null
  /** Asked to pass delete_files / deleteData to the whole torrent. */
  removeWholeTorrent: boolean
}

export interface RetirementDecision {
  retire: boolean
  blocked: boolean
  branch: "ratio" | "time" | "none"
  reason: string
  /** Paths this decision would retire. Empty unless retire is true. Never the output path. */
  deletePaths: string[]
  /** Whole-torrent data removal. Stays false unless every owned file is eligible. */
  removeTorrentData: boolean
}

export function emptyCompletion(hash: string): CompletionMemory {
  return { hash, seenIncomplete: false, completedAt: null, completedAtSource: null }
}

/** Client completion_on only. added_on is ignored on purpose. */
export function clientCompletionAt(raw: { completion_on?: number | null; added_on?: number | null }): number | null {
  const value = raw.completion_on
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * Remember the first reliable completion instant.
 * A later poll, recheck, or restart must not move completedAt forward.
 */
export function observeCompletion(previous: CompletionMemory | null, observation: CompletionObservation): CompletionMemory {
  const base = previous && previous.hash === observation.hash ? previous : emptyCompletion(observation.hash)
  if (base.completedAt != null) return base
  if (!observation.complete) {
    return { ...base, seenIncomplete: true }
  }
  const fromClient = observation.clientCompletedAt
  if (typeof fromClient === "number" && Number.isFinite(fromClient) && fromClient > 0) {
    return { ...base, completedAt: fromClient, completedAtSource: "client" }
  }
  if (base.seenIncomplete && Number.isFinite(observation.now)) {
    return { ...base, completedAt: observation.now, completedAtSource: "observed" }
  }
  return base
}

export function evaluateSeedingGate(input: {
  counters: SeedingCounters
  completedAt: number | null
  now: number
}): SeedingGate {
  const ratioKnown = input.counters.fresh && !input.counters.error
    && typeof input.counters.ratio === "number"
    && Number.isFinite(input.counters.ratio)
    && typeof input.counters.downloaded === "number"
    && Number.isFinite(input.counters.downloaded)
  const ratioReached = ratioKnown && (input.counters.downloaded as number) > 0 && (input.counters.ratio as number) >= SEED_RATIO_MIN
  const timeKnown = typeof input.completedAt === "number"
    && Number.isFinite(input.completedAt)
    && input.completedAt > 0
    && Number.isFinite(input.now)
  const elapsed = timeKnown ? input.now - (input.completedAt as number) : null
  const timeReached = elapsed != null && elapsed >= SEED_WALL_SECONDS

  if (ratioReached) {
    return { satisfied: true, blocked: false, branch: "ratio", reason: "У этого торрента ratio не ниже 3." }
  }
  if (timeReached) {
    return {
      satisfied: true,
      blocked: false,
      branch: "time",
      reason: "С окончания скачивания прошло 72 часа по часам, включая паузы и простой.",
    }
  }
  if (!ratioKnown && !timeKnown) {
    return {
      satisfied: false,
      blocked: true,
      branch: "none",
      reason: "Нет ни достоверного ratio, ни даты окончания скачивания. Раздача и исходник остаются.",
    }
  }
  if (!ratioKnown) {
    return {
      satisfied: false,
      blocked: true,
      branch: "none",
      reason: "Счётчик ratio недостоверен, а 72 часа с окончания скачивания ещё не прошли. Исходник остаётся.",
    }
  }
  if (input.counters.downloaded === 0) {
    return {
      satisfied: false,
      blocked: true,
      branch: "none",
      reason: "Скачано 0 байт. Большой ratio при нулевой загрузке не считается порогом. Исходник остаётся.",
    }
  }
  return {
    satisfied: false,
    blocked: false,
    branch: "none",
    reason: "Порог раздачи ещё не достигнут: ratio ниже 3 и 72 часа с окончания скачивания не прошли.",
  }
}

function verificationGap(report: VerificationReport | null): string | null {
  if (!report) return "Результат ещё не проверен. Исходник остаётся."
  if (!report.containerOk) return "Контейнер результата не проверен. Исходник остаётся."
  if (!report.decodeOk) return "Декодирование результата не проверено. Исходник остаётся."
  if (!report.durationOk) return "Длительность результата не совпала. Исходник остаётся."
  if (!report.tracksOk) return "Нужные дорожки в результате не сохранены. Исходник остаётся."
  if (!report.presetAccepted) {
    return "Код выхода 0 и меньший размер не подтверждают пресет. Субъективное качество само не считается доказанным. Исходник остаётся."
  }
  return null
}

function sameIdentity(recorded: FileIdentity, current: FileIdentity): boolean {
  return current.path === recorded.path && current.size === recorded.size && current.sha256 === recorded.sha256
}

export function decideSourceRetirement(input: RetirementInput): RetirementDecision {
  const none = (reason: string, blocked: boolean): RetirementDecision => ({
    retire: false,
    blocked,
    branch: "none",
    reason,
    deletePaths: [],
    removeTorrentData: false,
  })

  if (input.destinationError === "full" || input.destinationError === "network") {
    return none("На значении нет места или сеть оборвалась. Исходник остаётся.", false)
  }
  if (input.destination !== "committed") {
    return none("Результат ещё не на постоянном носителе. Временный staging исходник не заменяет.", false)
  }
  const gap = verificationGap(input.verification)
  if (gap) return none(gap, false)
  if (!input.outputPath || input.outputPath === input.recordedSource.path) {
    return none("Нельзя заменить раздаваемый файл на месте. Выход должен быть отдельным.", true)
  }

  let branch: "ratio" | "time" | "none" = "none"
  if (input.seeding) {
    const gate = evaluateSeedingGate({
      counters: input.seeding.counters,
      completedAt: input.seeding.completedAt,
      now: input.seeding.now,
    })
    if (!gate.satisfied) return { ...none(gate.reason, gate.blocked), branch: "none" }
    branch = gate.branch
  }

  if (input.files) {
    const own = input.files.find((file) => file.path === input.recordedSource.path)
    if (own?.heldByOtherTorrent) {
      return none("Этот файл ещё держит другая раздача, которая порог не прошла.", true)
    }
    const unfinished = input.files.some((file) => !file.processed || file.heldByOtherTorrent)
    if (input.removeWholeTorrent && unfinished) {
      return none("В торренте ещё есть необработанные или чужие ссылки. Данные раздачи целиком не снимаются.", true)
    }
  }

  if (!input.sourceNow) {
    return none("Исходника уже нет. Готовый результат из-за этого не удаляется.", false)
  }
  if (input.sourceNow.path === input.outputPath) {
    return none("Повтор после сбоя не удаляет готовый результат.", true)
  }
  if (!sameIdentity(input.recordedSource, input.sourceNow)) {
    return none("Файл на диске не совпал с тем, который обрабатывали. Он не удаляется.", true)
  }

  const deletePaths = [input.recordedSource.path]
  const whole = input.removeWholeTorrent === true
    && !!input.files
    && input.files.length > 0
    && input.files.every((file) => file.processed && !file.heldByOtherTorrent)
  return {
    retire: true,
    blocked: false,
    branch,
    reason: branch === "time"
      ? "Проверенный результат на месте, и с окончания скачивания прошло 72 часа. Этот исходник можно снять."
      : branch === "ratio"
        ? "Проверенный результат на месте, и ratio этого торрента не ниже 3. Этот исходник можно снять."
        : "Проверенный результат на постоянном носителе. Этот исходник можно снять.",
    deletePaths,
    removeTorrentData: whole,
  }
}
