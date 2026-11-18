"use strict";

export const SSE_COALESCE_MS = 2_000;

const HEAVY_PAGES = new Set(["devices", "drives", "hosts", "games", "media", "optical", "localsend", "policies", "scheduler", "jobs", "integrity", "torrents", "overview"]);

/** Idle time does not schedule a request. `now` is accepted and ignored. */
export function pollPlan({ hidden, reason, now }) {
  void now;
  if (hidden) return { fast: false, heavy: false };
  if (reason === "job") return { fast: true, heavy: false };
  if (reason === "open" || reason === "show" || reason === "navigate") return { fast: false, heavy: true };
  return { fast: false, heavy: false };
}

export function sseDue({ hidden, lastAt, now }) {
  if (hidden) return false;
  if (!lastAt) return true;
  return now - lastAt >= SSE_COALESCE_MS;
}

export function sectionDue(page) {
  return HEAVY_PAGES.has(page);
}

const PLATFORM_LABEL = {
  windows: "Windows",
  macos: "macOS",
  switch: "Switch",
  psp: "PSP",
  ps2: "PS2",
  ps4: "PS4",
};

/** The shelf API returns platforms[].games. An empty list stays empty. */
export function flattenShelfGames(payload) {
  if (!payload || payload.showingSamples === true || !Array.isArray(payload.platforms)) return [];
  const games = [];
  for (const platform of payload.platforms) {
    if (!platform || !Array.isArray(platform.games)) continue;
    const label = PLATFORM_LABEL[platform.id] || (typeof platform.label === "string" ? platform.label : "");
    for (const game of platform.games) {
      if (!game || typeof game.name !== "string" || !game.name) continue;
      games.push({
        id: typeof game.id === "string" ? game.id : "",
        contentId: typeof game.id === "string" ? game.id : game.name,
        name: game.name,
        platform: label,
        placement: typeof game.placement === "string" ? game.placement : "",
        sizeBytes: null,
      });
    }
  }
  return games;
}

export const CONFIRM = {
  invReset: ["Сбросить хост?", "Настройки qBittorrent этого хоста будут сброшены.", "Сбросить"],
  invRemove: ["Удалить хост?", "Хост исчезнет из панели.", "Удалить хост"],
  invRemoveTorrent: ["Удалить раздачу?", "Раздача будет удалена. Файлы на диске не удаляются этой кнопкой.", "Удалить"],
  invEraseTorrent: ["Удалить раздачу и данные?", "Раздача и её файлы на диске будут удалены.", "Удалить"],
  invKeepData: ["Удалить раздачу?", "Раздача исчезнет. Файлы на диске останутся.", "Удалить"],
  pipeDelete: ["Удалить источник?", "Исходные файлы будут удалены после проверки копии.", "Удалить источник"],
  confirmSourceDelete: ["Удалить источник?", "Исходные файлы будут удалены после проверки копии.", "Удалить источник"],
  integrityConfirm: ["Подтвердить проверку?", "Проверка SHA-256 будет закрыта.", "Подтвердить"],
  integrityCancel: ["Отменить проверку?", "Текущая проверка будет остановлена.", "Отменить"],
  shopApply: ["Применить правила?", "По правилам будут поставлены задачи раскладки.", "Применить"],
  policyApply: ["Применить правила?", "По правилам будут поставлены задачи раскладки.", "Применить"],
  shopTray: ["Команда приводу?", "Лоток оптического привода будет открыт или закрыт.", "Выполнить"],
  shopBlank: ["Вставить носитель?", "В привод будет отмечен чистый диск.", "Вставить"],
  opticalJob: ["Записать диск?", "Будет поставлена запись на оптический диск.", "Записать"],
  opticalControl: ["Команда приводу?", "Привод получит эту команду.", "Выполнить"],
  cancel: ["Отменить задачу?", "Задача или операция будет остановлена.", "Отменить"],
};

export function confirmSpec(name, page) {
  if (name === "run" && page === "optical") return { title: "Записать диск?", description: "Будет поставлена запись на оптический диск.", label: "Записать" };
  const row = CONFIRM[name];
  if (!row) return null;
  return { title: row[0], description: row[1], label: row[2] };
}

globalThis.LivePoll = {
  SSE_COALESCE_MS,
  pollPlan,
  sseDue,
  sectionDue,
  flattenShelfGames,
  confirmSpec,
};
