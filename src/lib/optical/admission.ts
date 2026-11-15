/** Whether a disc job may start or must yield. Pure: no disk, no drive, no Z:. */

export type PauseCause = "user" | "queue" | "disturb" | "schedule";

export interface AdmissionInput {
  queuePaused: boolean;
  disturb: boolean;
  maxParallel: number;
  running: number;
  withinSchedule: boolean;
}

export interface AdmissionDecision {
  start: boolean;
  reason: "queue" | "disturb" | "schedule" | "parallel" | null;
}

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  if (input.queuePaused) return { start: false, reason: "queue" };
  if (input.disturb) return { start: false, reason: "disturb" };
  if (!input.withinSchedule) return { start: false, reason: "schedule" };
  if (!Number.isFinite(input.maxParallel) || input.maxParallel < 1 || input.running >= input.maxParallel) {
    return { start: false, reason: "parallel" };
  }
  return { start: true, reason: null };
}

/** Parallel slot blocks a new start. It does not suspend the job that already holds the slot. */
export function shouldSuspendRunning(decision: AdmissionDecision): boolean {
  return decision.reason === "queue" || decision.reason === "disturb" || decision.reason === "schedule";
}

export function automaticPause(cause: string | null | undefined): boolean {
  return cause === "queue" || cause === "disturb" || cause === "schedule";
}

/**
 * UTC window. `startHour === endHour` is the whole day.
 * A window that crosses midnight (22 → 6) includes both ends of the night.
 */
export function hourInSchedule(hour: number, schedule: { startHour: number; endHour: number } | null): boolean {
  if (!schedule) return true;
  const start = normalizeHour(schedule.startHour);
  const end = normalizeHour(schedule.endHour);
  const now = normalizeHour(hour);
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function normalizeHour(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(23, Math.max(0, Math.floor(value)));
}
