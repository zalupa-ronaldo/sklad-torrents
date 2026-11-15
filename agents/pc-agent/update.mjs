import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { rejectedVolume } from "./load-policy.mjs";

function refuse(value) {
  if (rejectedVolume(value)) throw new Error("Этот том не используется.");
}

export function applyRelease({ root, version, runningFrom }) {
  refuse(root);
  if (runningFrom) refuse(runningFrom);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(version || ""))) {
    throw new Error("Некорректная версия сборки.");
  }
  const release = path.join(root, "releases", version);
  const current = path.join(root, "current");
  const previous = path.join(root, "previous");
  const data = path.join(root, "data");
  if (!existsSync(release)) throw new Error("Сборка не найдена.");
  if (runningFrom && existsSync(current)) {
    const from = path.resolve(runningFrom);
    const active = path.resolve(current);
    if (from === active || from.startsWith(active + path.sep)) {
      throw new Error("Сначала остановите службу: она запущена из текущей сборки.");
    }
  }
  if (path.resolve(release) === path.resolve(data) || path.resolve(release).startsWith(path.resolve(data) + path.sep)) {
    throw new Error("Данные не заменяются.");
  }
  mkdirSync(root, { recursive: true });
  if (existsSync(previous)) renameSync(previous, path.join(root, `previous-${Date.now()}`));
  if (existsSync(current)) renameSync(current, previous);
  renameSync(release, current);
  writeFileSync(path.join(root, "active-release"), `${version}\n`, { mode: 0o600 });
  return { current, previous: existsSync(previous) ? previous : null, data };
}

export function rollbackRelease(root) {
  refuse(root);
  const current = path.join(root, "current");
  const previous = path.join(root, "previous");
  if (!existsSync(previous)) throw new Error("Нет предыдущей сборки.");
  const failed = path.join(root, "failed");
  if (existsSync(failed)) renameSync(failed, path.join(root, `failed-${Date.now()}`));
  if (existsSync(current)) renameSync(current, failed);
  renameSync(previous, current);
  return { current };
}
