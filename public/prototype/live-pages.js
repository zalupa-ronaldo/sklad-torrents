"use strict";

function text(value) {
  return value == null || value === "" ? "не сообщается" : esc(String(value));
}

function rowsOf(section) {
  if (!section || section.ok === false) return [];
  const data = section.data;
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.games)) return data.games;
  if (Array.isArray(data.jobs)) return data.jobs;
  if (Array.isArray(data.devices)) return data.devices;
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.transfers)) return data.transfers;
  if (Array.isArray(data.hits)) return data.hits;
  if (Array.isArray(data.runs)) return data.runs;
  if (Array.isArray(data.queues)) return data.queues;
  return [];
}

function sectionNote(section, emptyText) {
  if (!section) return empty(emptyText);
  if (section.ok === false) return `<p class="error-message">${esc(section.error || "Раздел не ответил.")}</p>`;
  return "";
}

function input(id, label, value) {
  return `<label class="field">${esc(label)}<input id="${id}" value="${esc(value || "")}"></label>`;
}

function moveForm(s) {
  const files = Array.isArray(s.files) ? s.files.filter((file) => file && file.path && file.diskId) : [];
  const dests = Array.isArray(s.destinations) ? s.destinations : [];
  const picked = byId(files, s.ui.form.source) || files[0];
  const dest = byId(dests, s.ui.form.dest) || dests.find((item) => item.online) || dests[0];
  const fileChoices = files.map((file) => [file.id, file.name]);
  const destChoices = dests.map((item) => [item.id, item.label + (item.online ? "" : " · не в сети")]);
  return `<form id="move-form" class="form-grid">${files.length ? field("source", "Файл", fileChoices, picked?.id) : input("sourcePath", "Путь файла", s.ui.form.sourcePath)}${files.length ? "" : input("diskId", "Диск источника", s.ui.form.diskId)}${dests.length ? field("dest", "Куда", destChoices, dest?.id) : input("destination", "Назначение", s.ui.form.destination)}
    <p class="empty-hint">${esc(picked?.path || s.ui.form.sourcePath || "")}${dest ? " → " + esc(dest.label) : ""}</p>
    ${button("liveCopy", "Копировать", "", "primary", "")}</form>`;
}

function av1Card(s) {
  const av1 = s.live?.av1;
  if (!av1 || av1.online === false) {
    return card("AV1 на Windows", empty("Агент ПК не в сети. Кодирование не запускалось."));
  }
  const lanes = Array.isArray(av1.lanes) ? av1.lanes : [];
  if (!lanes.length) return card("AV1 на Windows", empty("Агент ответил, журналов кодирования нет."));
  const body = lanes
    .map((lane) => {
      const facts = [
        ["Файл", lane.currentFile],
        ["Процент", lane.percent == null ? null : lane.percent],
        ["Кадры/с", lane.fps],
        ["Осталось, с", lane.etaSec],
        ["Готово", lane.done == null && lane.total == null ? null : `${lane.done ?? "—"} / ${lane.total ?? "—"}`],
        ["Освобождено, байт", lane.spaceFreedBytes],
      ];
      const list = facts
        .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${text(value)}</dd></div>`)
        .join("");
      const errors = (lane.errors || []).map((error) => `<p class="error-message">${esc(error)}</p>`).join("");
      return `<article class="device-panel"><h3>${esc(lane.label)}</h3><p class="device-path">${esc(lane.dir || "")}</p><dl class="file-facts">${list}</dl>${errors}</article>`;
    })
    .join("");
  return card("AV1 на Windows", body);
}

function devicesLive(s) {
  const hosts = Array.isArray(s.hosts) ? s.hosts : [];
  const disks = Array.isArray(s.disks) ? s.disks : [];
  if (!disks.length) return card("Устройства", empty("Носителей в ответе полки нет.") + button("rescan", "Пересканировать"));
  return (
    hosts
      .map((host) => {
        const list = disks.filter((disk) => disk.host === host.id);
        if (!list.length) return "";
        const cards = list
          .map((disk) => {
            const online = available(s, disk);
            const used = typeof disk.sizeBytes === "number" && typeof disk.freeBytes === "number" ? disk.sizeBytes - disk.freeBytes : null;
            return `<article class="device-panel card ${online ? "" : "device-offline"}"><div class="device-heading"><h3>${esc(disk.label)}</h3><span class="device-status">${online ? "В сети" : "Не в сети"}</span></div>
            <p class="device-path">${esc(disk.mount || "точка монтирования не сообщается")} · ${esc(disk.fs || "файловая система не сообщается")}</p>
            <div class="device-volume"><span>Занято <b>${bytes(used)}</b></span><span>Свободно <b>${bytes(disk.freeBytes)}</b></span></div>
            <p class="scan-time">Был в сети · ${esc(dateText(disk.lastSeen))}</p>
            <div class="device-actions">${button("disk", "Открыть в каталоге", disk.id)}${button("rescan", "Пересканировать", disk.id)}</div></article>`;
          })
          .join("");
        return `<section class="device-host"><h2>${esc(host.name)} <span class="count">${list.length}</span></h2><div class="device-grid">${cards}</div></section>`;
      })
      .join("") + button("rescan", "Пересканировать полку")
  );
}

function fileDetailsLive(s) {
  const files = Array.isArray(s.files) ? s.files : [];
  const file = byId(files, s.ui.fileId);
  const back = button("backToFiles", "Вернуться в каталог");
  if (!file) return card("Детали файла", empty("Файл не выбран. Откройте его из каталога.") + back);
  const disk = diskOf(s, file);
  const copies = files.filter((item) => item.contentId && item.contentId === file.contentId);
  const hash = (s.tasks || []).find((job) => job.sha256 && job.operation?.fileId === file.id)?.sha256;
  return `<div class="detail-back">${back}</div><div class="detail-grid"><div>${card(
    esc(file.name),
    `<dl class="file-facts"><div><dt>Путь</dt><dd>${esc(file.path || pathOf(s, file))}</dd></div><div><dt>Размер</dt><dd>${bytes(file.sizeBytes)}</dd></div><div><dt>Носитель</dt><dd>${esc(disk?.label || "не сопоставлен")}</dd></div><div><dt>Тип</dt><dd>${text(file.type)}</dd></div></dl>
      <h3>SHA-256</h3>${hash ? `<code class="checksum">${esc(hash.source || hash.dest || "")}</code><p class="task-route">${hash.verified === true ? "совпала" : hash.verified === false ? "различается" : "без сверки"}</p>` : empty("Сумма появится у задачи копирования.")}
      <div class="file-actions">${button("page", "Перенос и копирование", "move")}${button("download", "Скачать")}${button("page", "LocalSend", "localsend")}</div>`,
  )}</div><div>${card(
    "Копии",
    copies
      .map((copy) => {
        const carrier = diskOf(s, copy);
        return `<p class="task-route">${esc(carrier?.label || copy.diskId)} · ${esc(copy.path || copy.name)}</p>`;
      })
      .join("") || empty("Других копий в этом ответе нет."),
  )}</div></div>`;
}

function hostsPage(s) {
  const hosts = s.torrentHosts || [];
  const list = hosts
    .map(
      (host) =>
        `<p class="task-route">${esc(host.name)} · ${host.online ? "В сети" : "Нет связи"} <button type="button" data-action="pickHost" data-value="${esc(host.id)}">Выбрать</button></p>`,
    )
    .join("");
  return card(
    "Хосты qBittorrent",
    `${list || empty("Хостов qBittorrent нет.")}<form class="form-grid">${input("hostId", "Идентификатор", s.ui.form.hostId)}${input("name", "Имя", s.ui.form.name)}${input("baseUrl", "Адрес Web UI", s.ui.form.baseUrl)}${input("username", "Имя пользователя", s.ui.form.username)}${input("password", "Пароль", "")}${field("os", "Система", ["darwin", "win32"], s.ui.form.os || "darwin")}
      <div class="file-actions">${button("hostTest", "Проверить")}${button("hostSave", "Сохранить", "", "primary")}${button("hostReset", "Сбросить демо")}${button("hostDelete", "Удалить")}</div></form>`,
  );
}

function gamesPage(s) {
  const note = sectionNote(s.live?.games, "Список игр не загрузился.");
  const games = rowsOf(s.live?.games);
  const cards = games
    .map(
      (game) =>
        `<article class="device-panel"><h3>${esc(game.name || game.id)}</h3><p class="device-path">${esc(game.platformLabel || game.platform || "платформа не сообщается")} · ${esc(game.placement || "")}</p>
        <div class="device-actions">${button("gameLaunch", "Запустить", game.id)}${button("gameWant", "Хочу играть", game.id)}${button("gameReturn", "Вернуть на HDD", game.id)}</div></article>`,
    )
    .join("");
  return card("Игровая полка", note + (cards || empty("Игр в ответе нет.")) + `<form class="form-grid">${input("gameId", "Идентификатор игры", s.ui.form.gameId)}</form>`);
}

function schedulerPage(s) {
  const auto = s.live?.auto;
  const runs = rowsOf(auto);
  const banner = runs
    .map((run) => `<p class="task-route">${esc(run.title || run.name || run.id || "шаг")} · ${esc(run.status || "")}</p>`)
    .join("");
  return card(
    "Планировщик",
    `${sectionNote(auto, "Авторежим не ответил.")}${banner || empty("Шагов конвейера нет.")}<form class="form-grid">${input("schedulerAction", "Действие", s.ui.form.schedulerAction || "next")}${input("diskKey", "Диск", s.ui.form.diskKey)}${input("torrentKey", "Раздача", s.ui.form.torrentKey)}${input("hostId", "Хост", s.ui.form.hostId)}${input("hash", "Хеш", s.ui.form.hash)}
      ${button("schedulerAct", "Применить", "", "primary")}</form>`,
  );
}

function localsendPage(s) {
  const devices = rowsOf(s.live?.devices);
  const jobs = rowsOf(s.live?.sendJobs);
  return card(
    "LocalSend",
    `${sectionNote(s.live?.devices, "Устройства не ответили.")}${devices.map((device) => `<p class="task-route">${esc(device.alias || device.fingerprint || device.name || "устройство")}</p>`).join("") || empty("Устройств нет.")}
      ${jobs.map((job) => `<p class="task-route">${esc(job.id)} · ${esc(job.state || "")}</p>`).join("")}
      <form class="form-grid">${input("fingerprint", "Отпечаток", s.ui.form.fingerprint)}${input("alias", "Имя", s.ui.form.alias)}${input("sourcePath", "Путь", s.ui.form.sourcePath)}
      <div class="file-actions">${button("localsendAdd", "Добавить устройство")}${button("localsendSend", "Отправить", "", "primary")}${button("localsendSettings", "Сохранить имя")}</div></form>`,
  );
}

function opticalPage(s) {
  return card(
    "Оптические диски",
    `${sectionNote(s.live?.opticalCap, "Возможности привода не ответили.")}${sectionNote(s.live?.opticalCatalog, "")}<form class="form-grid">${input("name", "Имя", s.ui.form.name)}${input("sourcePath", "Путь", s.ui.form.sourcePath)}${input("opticalAction", "Команда приводу", s.ui.form.opticalAction || "eject")}
      <div class="file-actions">${button("opticalJob", "Поставить запись", "", "primary")}${button("opticalImage", "Собрать образ")}${button("opticalControl", "Команда приводу")}${button("opticalDemo", "Демо оптики")}</div></form>`,
  );
}

function policiesPage(s) {
  const jobs = rowsOf(s.live?.policyJobs);
  return card(
    "Правила раскладки",
    `${sectionNote(s.live?.policies, "Правила не ответили.")}${jobs.map((job) => `<p class="task-route">${esc(job.torrentName || job.id)} · ${esc(job.status || job.kind || "")}</p>`).join("") || empty("Задач правил нет.")}
      <form class="form-grid">${input("presetId", "Пресет", s.ui.form.presetId)}${input("policyJobId", "Задача", s.ui.form.policyJobId)}${input("automation", "Автоматика 1/0", s.ui.form.automation)}
      <div class="file-actions">${button("policyPreset", "Записать пресет")}${button("policyPreview", "Пробный прогон")}${button("policyAuto", "Автоматика")}${button("policyApply", "Применить", "", "primary")}${button("policyConfirm", "Подтвердить задачу")}</div></form>`,
  );
}

function integrityPage(s) {
  return card(
    "Проверка SHA-256",
    `<form class="form-grid">${input("integrityId", "Идентификатор проверки", s.ui.form.integrityId)}${input("jobId", "Задача очереди", s.ui.form.jobId)}
      <div class="file-actions">${button("integrityGet", "Прочитать")}${button("integrityCancel", "Отменить")}${button("integrityConfirm", "Подтвердить", "", "primary")}${button("confirmSourceDelete", "Удалить источник")}</div></form>`,
  );
}

function toolsPage(s) {
  const jobs = rowsOf(s.live?.tools);
  return card(
    "Инструменты",
    `${sectionNote(s.live?.tools, "Инструменты не ответили.")}${jobs.map((job) => `<p class="task-route">${esc(job.title || job.id)} · ${esc(job.status || job.state || "")}</p>`).join("")}
      <form class="form-grid">${field("toolKind", "Операция", ["compress", "move", "transcode"], s.ui.form.toolKind || "compress")}${input("hostId", "Хост", s.ui.form.hostId)}${input("folderPath", "Папка", s.ui.form.folderPath)}${input("algorithm", "Алгоритм", s.ui.form.algorithm || "LZX")}${input("sourcePath", "Источник", s.ui.form.sourcePath)}${input("destination", "Назначение", s.ui.form.destination)}${input("toolJobId", "Задача", s.ui.form.toolJobId)}${input("query", "Поиск индекса", s.ui.form.query)}
      <div class="file-actions">${button("toolJob", "Поставить в очередь", "", "primary")}${button("toolAction", "Пауза задачи")}${button("mediaIndex", "Обновить индекс")}${button("mediaSearch", "Искать в индексе")}${button("toolConfig", "Записать настройки")}${button("encodePolicy", "Политика AV1")}</div></form>`,
  );
}

function torrentsExtra(s) {
  const jobs = rowsOf(s.live?.transfers);
  return card(
    "Перенос раздач",
    `${jobs.map((job) => `<p class="task-route">${esc(job.title || job.id)} · ${esc(job.status || job.state || "")}</p>`).join("") || empty("Переносов нет.")}
      <form class="form-grid">${input("torrentId", "Хеш раздачи", s.ui.form.torrentId)}${input("destination", "Каталог назначения", s.ui.form.destination)}${input("kind", "Тип для правила", s.ui.form.kind || "video")}${input("transferId", "Задача переноса", s.ui.form.transferId)}${input("hostId", "Хост наблюдателя", s.ui.form.hostId)}
      <div class="file-actions">${button("torrentTransfer", "Перенести", "", "primary")}${button("torrentDelete", "Удалить раздачу")}${button("torrentHashes", "Хеши")}${button("torrentPlacement", "Раскладка")}${button("torrentOverride", "Переопределить тип")}${button("transferControl", "Пауза переноса")}${button("transferPolicy", "Политика переноса")}${button("supervisor", "Наблюдатель")}</div></form>`,
  );
}

function progressExtra(s) {
  const jobs = rowsOf(s.live?.progress);
  return card(
    "Прогресс",
    `${jobs.map((job) => `<p class="task-route">${esc(job.title || job.id)} · ${esc(job.status || "")}</p>`).join("") || empty("Операций прогресса нет.")}
      <form class="form-grid">${input("progressId", "Операция", s.ui.form.progressId)}${input("progressAction", "Действие", s.ui.form.progressAction || "pause")}
      <div class="file-actions">${button("progressAction", "Применить", "", "primary")}${button("progressQueue", "Пауза очереди")}${button("progressLoad", "Записать нагрузку")}${button("progressLink", "Записать канал")}</div></form>`,
  );
}

const livePageNames = new Set(["move", "devices", "details", "hosts", "games", "scheduler", "localsend", "optical", "policies", "integrity", "tools"]);

const LivePages = {
  handles(page) {
    return livePageNames.has(page);
  },
  render(s) {
    const page = s.ui.page;
    if (page === "move") return card("Перенос и копирование", moveForm(s));
    if (page === "devices") return devicesLive(s);
    if (page === "details") return fileDetailsLive(s);
    if (page === "hosts") return hostsPage(s);
    if (page === "games") return gamesPage(s);
    if (page === "scheduler") return schedulerPage(s);
    if (page === "localsend") return localsendPage(s);
    if (page === "optical") return opticalPage(s);
    if (page === "policies") return policiesPage(s);
    if (page === "integrity") return integrityPage(s);
    if (page === "index" || page === "tools") return toolsPage(s);
    return empty("Раздел не собран.");
  },
  av1: av1Card,
  torrentsExtra,
  progressExtra,
  moveForm,
};

globalThis.LivePages = LivePages;
