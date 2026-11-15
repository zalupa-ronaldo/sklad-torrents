export interface StageSample {
  stage: string;
  ms: number;
  count: number;
}

const samples: StageSample[] = [];

/** Counts and durations only. No paths, names, or serials. */
export function recordStage(stage: string, ms: number, count: number): void {
  const sample = { stage, ms: Math.round(ms * 10) / 10, count };
  samples.push(sample);
  if (samples.length > 80) samples.shift();
  if (process.env.SKLAD_STAGE_LOG === "1") {
    console.info(`sklad.stage ${sample.stage} count=${sample.count} ms=${sample.ms}`);
  }
}

export function recentStages(): readonly StageSample[] {
  return samples;
}

export function clearStages(): void {
  samples.length = 0;
}

export function stageMaxGap(samplesIn: readonly StageSample[], stage: string): number {
  return samplesIn.filter((item) => item.stage === stage).reduce((max, item) => Math.max(max, item.ms), 0);
}
