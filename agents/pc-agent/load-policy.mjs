/**
 * Pause, restart and load decisions for the Windows agent.
 * The panel and the neighbours own their own queues. This module only
 * decides what the agent itself may do. It never deletes a source file.
 */

export const PROCESS_PRIORITIES = ["idle", "below-normal", "normal"];
export const DEFAULT_LOAD = {
  maxParallel: 1,
  processPriority: "below-normal",
  disturb: false,
  schedule: null,
};

const RESTART_ERROR = "Передача прервана перезапуском Склада. По протоколу она не завершена.";

export function fileLabel(filePath) {
  const parts = String(filePath || "").split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function rejectedVolume(input) {
  const raw = String(input || "").trim();
  const slash = raw.replace(/\\/g, "/");
  if (/^\/mnt\/z(\/|$)/i.test(slash)) return true;
  const win = raw.replace(/\//g, "\\");
  if (/^z:/i.test(win)) return true;
  if (/^\\\\\?\\z:/i.test(win)) return true;
  return false;
}

export function normalizeProcessPriority(value) {
  if (value === "idle" || value === "normal" || value === "below-normal") return value;
  if (value === "below" || value === "background") return "below-normal";
  return "below-normal";
}

export function effectiveParallel(own, neighbors = []) {
  const numbers = [own ?? DEFAULT_LOAD.maxParallel, ...neighbors].map((value) => Number(value));
  const usable = numbers.filter((value) => Number.isFinite(value) && value >= 0);
  return usable.length ? Math.min(...usable) : DEFAULT_LOAD.maxParallel;
}

export function scheduleHolds(schedule, hour) {
  if (!schedule || schedule.startHour == null || schedule.endHour == null) return false;
  const start = Number(schedule.startHour);
  const end = Number(schedule.endHour);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start === end) return false;
  const now = Number(hour);
  if (start < end) return now < start || now >= end;
  return now >= end && now < start;
}

export function channelKeepsQueue() {
  return { setPause: false, callResume: false, becameError: false };
}

export function admitHeavy({ running, maxParallel, userPaused, queueUserPaused, disturb, scheduleHold }) {
  if (userPaused || queueUserPaused || disturb || scheduleHold) return false;
  return Number(running) < Number(maxParallel);
}

export function pauseHandBrake({ processAlive }) {
  return {
    drainToBoundary: processAlive === true,
    publishPartial: false,
    deleteSource: false,
    stateAfterDrain: "paused",
  };
}

export function classifyEncodeExit(code) {
  return {
    restartFailure: false,
    handbrakeFallback: Number(code) === 3221225477,
    publishPartial: false,
    deleteSource: false,
  };
}

export function handbrakeTempPath(finalPath, jobId) {
  const token = String(jobId || "job").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "job";
  return `${finalPath}.sklad-part-${token}`;
}

export function restoreJob(job) {
  const processedBytes = Number.isFinite(job.processedBytes) ? job.processedBytes : 0;
  const currentFile = fileLabel(job.currentFile || job.inputPath);
  const userPaused = job.userPaused === true || job.pauseReason === "user";
  const base = {
    processedBytes,
    currentFile,
    callResume: false,
    publishPartial: false,
    deleteSource: false,
    becameError: false,
    renameTemp: false,
    stepIndex: undefined,
    restartFailure: false,
    retryIncompleteFromStart: false,
    keepCompletedFiles: true,
    clearError: false,
  };
  if (job.state === "paused" || userPaused) {
    return { ...base, state: "paused", userPaused: true, queuePaused: job.queuePaused === true };
  }
  if ((job.kind === "transcode" || job.kind === "handbrake") && job.state === "running") {
    const exit = classifyEncodeExit(job.exitCode);
    return {
      ...base,
      state: "queued",
      userPaused: false,
      queuePaused: false,
      retryIncompleteFromStart: true,
      keepCompletedFiles: true,
      restartFailure: exit.restartFailure,
      clearError: job.error === RESTART_ERROR || exit.handbrakeFallback,
    };
  }
  return { ...base, state: job.state, userPaused: false, queuePaused: job.queuePaused === true };
}

export function releaseQueueHold(job) {
  if (job.userPaused === true || job.pauseReason === "user") {
    return { state: "paused", userPaused: true, queuePaused: false };
  }
  if (job.queuePaused === true || job.state === "paused") {
    return { state: "queued", userPaused: false, queuePaused: false };
  }
  return { state: job.state, userPaused: false, queuePaused: false };
}
