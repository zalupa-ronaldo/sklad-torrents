import { adviseCompression, lookupCompactResult, type CompactDbAlgorithm, type CompactDbCache } from "@/lib/compact-db/database";

const ORDER: readonly CompactDbAlgorithm[] = ["XPRESS8K", "XPRESS16K", "XPRESS4K", "LZX"];
const MONTH = 30 * 24 * 60 * 60 * 1000;

export interface CompactChoice {
  algorithm: CompactDbAlgorithm;
  enqueue: boolean;
  reason: string;
}

/**
 * An explicit compress request uses XPRESS8K unless a fresh community row
 * shows a better positive saving. Unknown and stale rows do not become zero
 * and do not block the explicit request.
 */
export function chooseCompactAlgorithm(input: {
  steamAppId: number | null;
  cache: CompactDbCache | null;
  already: string | null;
  nowMs?: number;
}): CompactChoice {
  const already = isAlgorithm(input.already) ? input.already : null;
  const picked = bestFromDatabase(input.steamAppId, input.cache, input.nowMs ?? Date.now());
  const algorithm = picked?.algorithm ?? "XPRESS8K";
  if (already === algorithm) {
    return { algorithm, enqueue: false, reason: "Эта папка уже сжата тем же алгоритмом. Повторно не сжимается." };
  }
  if (!picked) {
    return {
      algorithm: "XPRESS8K",
      enqueue: true,
      reason: "В свежей базе CompactGUI нет строки с положительной экономией. Ручная постановка использует XPRESS8K и не считает неизвестную экономию нулём.",
    };
  }
  const advice = adviseCompression({
    lookup: picked.lookup,
    requested: picked.algorithm,
    alreadyAlgorithm: already,
    minSavings: null,
    manualOverride: false,
  });
  if (advice.action === "skip") return { algorithm: picked.algorithm, enqueue: false, reason: advice.reason };
  return {
    algorithm: picked.algorithm,
    enqueue: true,
    reason: `База CompactGUI для ${picked.algorithm} показывает положительную экономию. Сжатие ставится в очередь и в этом запросе не запускается.`,
  };
}

function bestFromDatabase(steamAppId: number | null, cache: CompactDbCache | null, nowMs: number): { algorithm: CompactDbAlgorithm; lookup: ReturnType<typeof lookupCompactResult> } | null {
  if (steamAppId == null || !cache?.valid) return null;
  let best: { algorithm: CompactDbAlgorithm; savings: number; lookup: ReturnType<typeof lookupCompactResult> } | null = null;
  for (const algorithm of ORDER) {
    const lookup = lookupCompactResult(cache, steamAppId, algorithm, { nowMs, maxAgeMs: MONTH });
    if (lookup.status !== "hit" || lookup.savings == null || lookup.savings <= 0) continue;
    if (!best || lookup.savings > best.savings) best = { algorithm, savings: lookup.savings, lookup };
  }
  return best;
}

function isAlgorithm(value: string | null): value is CompactDbAlgorithm {
  return value === "XPRESS4K" || value === "XPRESS8K" || value === "XPRESS16K" || value === "LZX";
}
