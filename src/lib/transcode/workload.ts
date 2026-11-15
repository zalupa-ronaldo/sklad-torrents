import { constants } from "node:os";

/** One machine. The other machine keeps its own pause, cap, and busy flag. */
export interface MachineLimit {
  maxParallel: number;
  priority: "below-normal" | "normal";
  yieldWhenBusy: boolean;
  paused: boolean;
  userBusy: boolean;
}

export const DEFAULT_MACHINE_LIMIT: MachineLimit = {
  /** Two local workers already encode side by side. The owner can set 1 in encode-policy.json. */
  maxParallel: 2,
  priority: "below-normal",
  yieldWhenBusy: true,
  paused: false,
  userBusy: false,
};

export function admitMachine(limit: MachineLimit, running: number): { admit: boolean; reason: string | null } {
  if (limit.paused) return { admit: false, reason: "Эта машина на паузе. Новый файл не начинается." };
  if (limit.yieldWhenBusy && limit.userBusy) return { admit: false, reason: "На этой машине играют или работают. Новый файл ждёт." };
  const cap = Math.max(1, Math.floor(limit.maxParallel));
  if (running >= cap) return { admit: false, reason: "На этой машине уже занят лимит параллельных задач." };
  return { admit: true, reason: null };
}

export function priorityLevel(priority: MachineLimit["priority"]): number {
  return priority === "normal" ? constants.priority.PRIORITY_NORMAL : constants.priority.PRIORITY_BELOW_NORMAL;
}

export function clampLimit(input: Partial<MachineLimit> | null | undefined): MachineLimit {
  const maxParallel = Number(input?.maxParallel);
  const priority = input?.priority === "normal" ? "normal" : "below-normal";
  return {
    maxParallel: Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 4 ? maxParallel : DEFAULT_MACHINE_LIMIT.maxParallel,
    priority,
    yieldWhenBusy: input?.yieldWhenBusy !== false,
    paused: input?.paused === true,
    userBusy: input?.userBusy === true,
  };
}
