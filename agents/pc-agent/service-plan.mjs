import { rejectedVolume } from "./load-policy.mjs";

export const SERVICE_TASK = "SkladPcAgent";

function assertAllowed(value, label) {
  if (rejectedVolume(value)) {
    const error = new Error("Этот том не используется.");
    error.status = 400;
    throw error;
  }
  if (!value || typeof value !== "string") {
    throw new Error(`Нужен путь: ${label}.`);
  }
}

export function autostartPlan({ nodePath, supervisorPath, statePath, logDir }) {
  assertAllowed(nodePath, "node");
  assertAllowed(supervisorPath, "supervisor");
  assertAllowed(statePath, "state");
  assertAllowed(logDir, "logs");
  return {
    taskName: SERVICE_TASK,
    trigger: "AtStartup",
    executable: nodePath,
    arguments: [supervisorPath],
    restartCount: 3,
    restartIntervalMinutes: 1,
    statePath,
    logDir,
    deletesUserFiles: false,
  };
}

export function serviceScriptIncludes(source) {
  const text = String(source);
  return {
    startsAtBoot: text.includes("AtStartup") && text.includes(SERVICE_TASK),
    keepsData: !/Remove-Item/.test(text),
    touchesExcludedVolume: /\bZ:\\|\/mnt\/z/i.test(text),
  };
}
