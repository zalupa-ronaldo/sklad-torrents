import type { JobKind, JobRunner, JobState, LibraryStatus, ToolHostId } from "@/addons/media-games/types";

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "В очереди",
  running: "Выполняется",
  verifying: "Проверка копии",
  "awaiting-confirm": "Ждёт подтверждения",
  completed: "Готово",
  failed: "Ошибка",
  cancelled: "Отменено",
};

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  transcode: "Перекодирование",
  move: "Перенос",
  compress: "Сжатие",
};

export const RUNNER_LABEL: Record<JobRunner, string> = {
  mock: "Демо",
  local: "Mac, локально",
  "pc-agent": "Агент Windows",
};

export const LIBRARY_STATUS_LABEL: Record<LibraryStatus, string> = {
  verified: "Проверено, источник на месте",
  moved: "Перенос подтверждён",
};

export function hostTitle(id: ToolHostId, name?: string): string {
  if (name && name.trim()) return name.trim();
  return id === "pc-agent" ? "Windows PC" : "Mac mini";
}
