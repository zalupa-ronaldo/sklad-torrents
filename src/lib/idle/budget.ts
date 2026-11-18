/**
 * Work wakes per minute while the collection page is open and nothing is queued.
 * Counted from the timers in ca1059a, not from a live container.
 * Job workers: two loops, each min(600, 400) ms. Scheduler 10s, placement 12s,
 * LocalSend announce 10s, client fast 5s, client heavy 60s.
 */
export const IDLE_WORK_WAKES_PER_MINUTE = {
  before: {
    scheduler: 6,
    placement: 5,
    localsendAnnounce: 6,
    jobWorkers: 300,
    clientFast: 12,
    clientHeavy: 1,
  },
  after: {
    scheduler: 0,
    placement: 0,
    localsendAnnounce: 0,
    jobWorkers: 0,
    clientFast: 0,
    clientHeavy: 0,
  },
} as const;

export function idleWorkWakes(side: "before" | "after"): number {
  const values = Object.values(IDLE_WORK_WAKES_PER_MINUTE[side]) as readonly number[];
  return values.reduce((sum, value) => sum + value, 0);
}
