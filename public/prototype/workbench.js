"use strict";

// View helpers take a snapshot; they never query or mutate the document.
const pages = {
  overview: ["Диспетчер", "LayoutDashboard", "Диски, файлы и обработка в локальной сети."],
  devices: ["Устройства", "Server", "Носители, свободное место и последние снимки каталога."],
  drives: ["Все файлы", "HardDrive", "Поиск по снимкам всех носителей, включая отключённые."],
  details: ["Детали файла", "File", "Сведения из индекса и размещение копий."],
  torrents: ["Торренты", "ArrowDownUp", "Раздачи qBittorrent на ваших хостах."],
  scheduler: ["Планировщик", "Clock3", "Одна активная загрузка на физический диск."],
  jobs: ["Очередь задач", "ListChecks", "Ход операций на ваших хостах."],
  games: ["Игровая полка", "Gamepad2", "Библиотека игр и подготовка копий на SSD."],
  move: ["Перенос и копирование", "ArrowDownUp", "Выберите файл и носитель назначения."],
  integrity: ["Проверка SHA-256", "Check", "Манифесты файлов и сверка копий."],
  index: ["Индекс файлов", "Database", "Поиск по снимкам и обновление индекса."],
  localsend: ["LocalSend", "Network", "Отправка и приём файлов по локальной сети."],
  optical: ["Оптические диски", "Disc3", "Образы, запись с проверкой и рисунок на поверхности."],
  policies: ["Правила раскладки", "Layers3", "Размещение и фоновая обработка по типу контента."],
};
const families = {
  hdd: ["HDD", "Жёсткие диски", "moss"],
  ssd: ["SSD", "SSD", "slate"],
  usb: ["USB", "USB-флешки", "amber"],
  sd: ["SD", "Карты памяти", "aqua"],
  optical: ["DISC", "CD / DVD / BD", "violet"],
};
const torrentStates = { down: "Загрузка", seed: "Раздача", pause: "Пауза", wait: "В очереди" };
const fileTypes = {
  image: ["Образ диска", "Disc3"],
  video: ["Видео", "Film"],
  archive: ["Архив", "FileArchive"],
  audio: ["Музыка", "Music2"],
  data: ["Данные", "Database"],
};
const mediaCapacity = { "CD-R": 734003200, "DVD-5": 4700372992, "DVD-DL": 8543666176, "BD-R 25 ГБ": 25e9 };
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`;
const num = (n) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const byId = (list, id) => list.find((row) => row.id === id);
const diskOf = (s, f) => byId(s.disks, f.diskId);
const hostOf = (s, d) => byId(s.hosts, d.host);
const available = (s, d) => Boolean(d?.online && hostOf(s, d)?.online);
const pathOf = (s, f) => (diskOf(s, f).mount || "") + f.dir + f.name;
const action = (name, value = "") => `data-action="${name}" data-value="${esc(value)}"`;
function button(name, label, value = "", classes = "secondary-action", extra = "") {
  return `<button type="button" class="${classes}" ${action(name, value)} ${extra}>${label}</button>`;
}
function bytes(n) {
  if (n == null) return "—";
  for (const [unit, scale] of [
    ["ТБ", 1e12],
    ["ГБ", 1e9],
    ["МБ", 1e6],
    ["КБ", 1e3],
  ])
    if (n >= scale) return num(n / scale) + " " + unit;
  return num(n) + " Б";
}
function dateText(value) {
  const date = new Date(value);
  return value && Number.isFinite(+date)
    ? date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "нет данных";
}
function select(id, choices, current, label, extra = "") {
  return `<select id="${id}" aria-label="${esc(label)}" ${extra}>${choices
    .map((item) => {
      const [value, text] = Array.isArray(item) ? item : [item, item];
      return `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(text)}</option>`;
    })
    .join("")}</select>`;
}
function field(id, label, choices, current) {
  return `<label class="field">${label}${select(id, choices, current, label)}</label>`;
}
function search(id, label, value) {
  return `<label class="search">${icon("Search")}<input id="${id}" type="search" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}"></label>`;
}
function card(title, content) {
  return `<section class="card work-card"><h2>${title}</h2>${content}</section>`;
}
function empty(text) {
  return `<p class="empty-hint">${text}</p>`;
}
function skeleton(label, count) {
  return `<div class="skeletons" aria-busy="true" aria-label="${label}"><span class="sr-only">${label}</span>${'<span aria-hidden="true"></span>'.repeat(count)}</div>`;
}
function meter(n, label) {
  const pct = Math.min(100, Math.max(0, n));
  return `<div class="track" role="progressbar" aria-label="${esc(label)}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
}
function sidebar(s) {
  const groups = { overview: "Рабочее пространство", games: "Библиотека и инструменты", localsend: "Сеть и автоматика" };
  const nav = Object.entries(pages)
    .filter(([key]) => key !== "details")
    .map(([key, [label, symbol]]) => {
      const active = s.ui.page === key || (key === "drives" && s.ui.page === "details");
      return (
        (groups[key] ? `<p class="caption">${groups[key]}</p>` : "") +
        button(
          "page",
          icon(symbol) + label + (key === "torrents" ? `<span class="count">${s.torrents.length}</span>` : ""),
          key,
          active ? "active" : "",
          active ? 'aria-current="page"' : "",
        )
      );
    })
    .join("");
  return `<div class="brand"><span class="brand-icon">${icon("Layers3")}</span>Склад<span class="brand-period">.</span></div><div class="side-inner"><nav id="module-nav" aria-label="Разделы">${nav}</nav>
    <div class="host-head"><p class="caption">Хосты</p><span class="count">${s.hosts.length}</span></div><nav aria-label="Хосты">${s.hosts.map((h) => button("host", icon(h.id === "mac" ? "Laptop" : "Monitor") + esc(h.name) + `<small class="host-state">${h.online ? "В сети" : "Нет связи"}</small>`, h.id, "")).join("")}</nav></div>
    <div class="side-foot">${icon("Network")}<div>Локальная сеть<small>Деморежим</small></div></div>`;
}
function topbar(s) {
  return `${button("menu", icon("Menu"), "", "icon-button", `id="menu" aria-label="Открыть навигацию" aria-controls="sidebar" aria-expanded="${s.ui.menu}"`)}
  <span class="breadcrumb">Рабочее пространство</span><i class="breadcrumb">${icon("ChevronRight")}</i><strong>${pages[s.ui.page][0]}</strong>
  <span class="online">В сети · ${s.hosts.filter((h) => h.online).length} / ${s.hosts.length}</span>
  <label class="scenario-label">Демо ${select("scenario", s.scenarioOptions, s.scenario, "Демосостояние")}</label>`;
}
function heading(s) {
  const page = s.ui.page;
  return (
    `<div><h1 id="title" tabindex="-1">${page === "overview" ? "Диспетчер склада" : pages[page][0]}</h1><p>${pages[page][2]}</p></div>` +
    (page === "overview"
      ? button("find", icon("Search") + "Найти файл", "", "primary")
      : page === "torrents"
        ? button(
            "add",
            icon("Plus") + "Добавить торрент",
            "",
            "primary",
            s.loading || !s.disks.some((d) => available(s, d)) ? "disabled" : "",
          )
        : "")
  );
}
function shelf(s) {
  const u = s.ui;
  const q = u.query.trim().toLocaleLowerCase("ru");
  const matches = s.disks.filter(
    (d) =>
      (!u.family || d.kind === u.family) &&
      (u.connection === "all" || available(s, d) === (u.connection === "on")) &&
      [d.label, d.kind, d.location, d.fs, hostOf(s, d).name].join(" ").toLocaleLowerCase("ru").includes(q),
  );
  const cards = Object.entries(families)
    .map(([kind, [model, label, tint]]) => {
      const list = s.disks.filter((d) => d.kind === kind);
      return button(
        "family",
        `<span aria-hidden="true" class="drive-art"><span class="hardware model-${model} ${kind === "optical" ? "opt-disc" : ""}"><span class="hw-label">${model}</span><i></i></span></span>
      <span class="family-title">${label}<b>${list.length}</b></span><small>Подключено · ${list.filter((d) => available(s, d)).length}</small>`,
        kind,
        "family " + tint,
        `aria-pressed="${u.family === kind}"`,
      );
    })
    .join("");
  const rows = matches
    .slice(0, u.limit)
    .map((d) => {
      const online = available(s, d);
      const detail = online ? hostOf(s, d).name + " · " + bytes(d.sizeBytes) : "Был в сети " + dateText(d.lastSeen);
      return button(
        "disk",
        `<span class="carrier-type">${families[d.kind][0]}</span><span class="carrier-label"><b>${esc(d.label)}</b><small>${esc(detail)}</small></span><span class="connect-state ${online ? "" : "off"}">${online ? "В сети" : "Не в сети"}</span>`,
        d.id,
        "inventory-drive" + (online ? "" : " unavailable"),
      );
    })
    .join("");
  const filters = q || u.family || u.connection !== "all";
  return `<section class="shelf-block"><div class="block-title"><h2>Коллекция носителей ${s.loading ? "" : `<span class="count">${s.disks.length}</span>`}</h2>
    ${button("find", "<span>Поиск файлов</span>" + icon("Search"), "", "secondary-action shelf-search", 'aria-label="Поиск файлов"')}</div>
    <div class="families">${s.loading ? skeleton("Загрузка коллекции", 5) : cards}</div>
    <div class="inventory-controls">${search("shelf-query", "Носитель, хост или место хранения", u.query)}${select(
      "shelf-filter",
      [
        ["all", "Любое подключение"],
        ["on", "В сети"],
        ["off", "Не в сети"],
      ],
      u.connection,
      "Подключение носителя",
    )}</div>
    <div class="inventory" id="rack">${s.loading ? skeleton("Загрузка списка дисков", 6) : rows || empty(s.disks.length ? "Ничего не найдено." : "Носителей пока нет.")}</div>
    ${s.loading ? "" : `<div class="inventory-foot"><span>Показано ${Math.min(matches.length, u.limit)} из ${matches.length} ${filters ? button("clearShelf", "Сбросить фильтры", "", "clear-shelf") : ""}</span>${matches.length > u.limit ? button("more", "Показать ещё") : ""}</div>`}</section>`;
}
function scanTime(iso) {
  if (!iso) return "Сканирования ещё не было";
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}
function devicesPage(s) {
  if (s.loading) return skeleton("Загрузка устройств", 5);
  if (!s.disks.length) return card("Носители", empty("Устройств в каталоге пока нет."));
  return s.hosts
    .map((host) => {
      const devices = s.disks.filter((d) => d.host === host.id);
      if (!devices.length) return "";
      const rows = devices
        .map((d) => {
          const online = available(s, d);
          const scan = s.tasks.find((j) => j.operation?.type === "index" && j.operation.target === d.id);
          const busy = scan && ["running", "paused"].includes(scan.state);
          const transfers = s.tasks.filter((j) => {
            if (j.state !== "running" || !["copy", "av1"].includes(j.kind)) return false;
            const op = j.operation;
            return op?.target === d.id || byId(s.files, op?.fileId)?.diskId === d.id;
          });
          const used = d.sizeBytes - d.freeBytes;
          const retry = scan?.state === "error";
          return `<article class="device-panel card ${online ? "" : "device-offline"}">
        <div class="device-heading"><span class="carrier-type">${families[d.kind][0]}</span><h3>${esc(d.label)}</h3><span class="device-status">${online ? "В сети" : "Не в сети"}</span></div>
        <p class="device-path">${esc(d.mount || d.location)} · ${esc(d.fs)}</p>
        ${meter(d.sizeBytes ? Math.round((100 * used) / d.sizeBytes) : 0, "Занято на " + d.label)}
        <div class="device-volume"><span>Занято <b>${bytes(used)}</b></span><span>Свободно <b>${bytes(d.freeBytes)}</b></span></div>
        <p class="scan-time">Последний скан · ${esc(scanTime(d.lastScan))}</p>
        ${busy ? `<p class="scan-time">${scan.state === "paused" ? "Сканирование на паузе" : "Идёт сканирование"} · ${num(scan.progress)}%</p>` : ""}
        ${transfers.map((j) => `<p class="scan-time">${esc(j.title)} · ${num(j.progress)}%</p>`).join("")}
        ${retry ? `<p class="error-message">${esc(scan.error)}</p>` : ""}
        <div class="device-actions">${button("disk", "Открыть в каталоге", d.id)}${button(retry ? "retry" : "reindex", retry ? "Повторить сканирование" : "Пересканировать", retry ? scan.id : d.id, "secondary-action", !online || busy ? "disabled" : "")}</div>
      </article>`;
        })
        .join("");
      return `<section class="device-host"><h2>${icon(host.id === "pc" ? "Monitor" : "Laptop")}${esc(host.name)} <span class="count">${devices.length}</span></h2><div class="device-grid">${rows}</div></section>`;
    })
    .join("");
}
function taskAvailable(s, j) {
  const op = j.operation;
  const source = op?.fileId && byId(s.files, op.fileId);
  return Boolean(
    byId(s.hosts, j.host)?.online &&
    (!op?.fileId || (source && available(s, diskOf(s, source)))) &&
    (!op?.target || available(s, byId(s.disks, op.target))),
  );
}
function queue(s, compact = false) {
  const tasks = compact ? s.tasks.slice(0, 2) : s.tasks.filter((j) => !s.ui.taskKind || j.kind === s.ui.taskKind);
  const rows = tasks
    .map((j) => {
      const label = { running: "Выполняется", paused: "На паузе", error: "Ошибка", done: "Готово" }[j.state];
      const active = ["running", "paused"].includes(j.state);
      const metrics =
        j.state === "running"
          ? `<span>${bytes(j.bytesPerSec)}/с · осталось ${j.etaSec == null ? "—" : Math.ceil(j.etaSec) + " с"}</span>`
          : "";
      const op = j.operation;
      const source = op?.fileId && byId(s.files, op.fileId);
      const target = op?.target && byId(s.disks, op.target);
      const online = taskAvailable(s, j);
      const route = source && target ? esc(diskOf(s, source).label) + " → " + esc(target.label) : "";
      return `<article class="job-row ${j.state}" data-job="${esc(j.id)}"><div class="job-body"><b>${esc(j.title)}</b>${!compact && route ? `<p class="task-route">${route}</p>` : ""}<small>${esc(byId(s.hosts, j.host)?.name)} · <strong>${label}</strong></small>
      ${j.state !== "done" ? meter(j.progress, j.title) : ""}<div class="job-metrics">${j.state !== "done" ? num(j.progress) + "%" : ""} ${metrics}</div>
      ${!online && active ? empty("Для продолжения подключите носитель и его хост.") : ""}
      ${j.state === "done" && j.verified ? '<p class="task-route">SHA-256 совпал</p>' : ""}
      ${j.error ? `<p class="error-message">${esc(j.error)}</p>` : ""}<div class="job-actions">${active ? button("pause", j.state === "paused" ? "Продолжить" : "Пауза", j.id, "secondary-action", j.state === "paused" && !online ? "disabled" : "") + button("cancel", "Отмена", j.id) : j.state === "error" ? button("retry", "Повторить", j.id, "secondary-action", online ? "" : "disabled") : ""}</div></div></article>`;
    })
    .join("");
  const filters =
    compact || s.loading
      ? ""
      : `<div class="queue-filters">${[
          ["", "Все задачи"],
          ["copy", "Копирование"],
          ["av1", "AV1"],
        ]
          .map(([kind, label]) =>
            button("taskKind", label, kind, "secondary-action", `aria-pressed="${s.ui.taskKind === kind}"`),
          )
          .join("")}</div>`;
  return `<section class="card queue-card"><div class="card-heading"><h2>${icon("ListChecks")}${compact ? "Очередь задач" : "Операции"} ${s.loading ? "" : `<span class="count">${tasks.length}</span>`}</h2>${compact ? button("page", "Все задания", "jobs") : ""}</div>${filters}${s.loading ? skeleton("Загрузка очереди", 2) : rows || empty(s.tasks.length && !compact ? "Задач выбранного типа нет." : "В очереди нет задач.")}</section>`;
}
function network(s) {
  const u = s.ui,
    period = Number(u.period),
    online = s.torrents.filter((t) => available(s, diskOf(s, t)));
  const series = s.history.slice(-(period * 3 + 1));
  if (!series.length)
    return card("Сетевая активность", s.loading ? skeleton("Загрузка графика", 2) : empty("Нет данных о скорости."));
  series[series.length - 1] = [
    online.reduce((n, t) => n + (t.state === "down" ? t.down : 0), 0),
    online.reduce((n, t) => n + (t.state === "seed" ? t.up : 0), 0),
  ];
  const last = series.length - 1,
    i = Math.min(u.sample ?? last, last),
    point = series[i],
    x = (580 * i) / last;
  const grid = [0, 26, 52, 78, 104]
    .map((y) => `<line x1="0" x2="580" y1="${y}" y2="${y}" stroke="#384036" stroke-dasharray="3 5"/>`)
    .join("");
  const area = series.map((v, n) => numPoint(n, v[0])).join(" ");
  const lines = [0, 1]
    .map(
      (k) =>
        `<polyline points="${series.map((v, n) => numPoint(n, v[k])).join(" ")}" fill="none" stroke="${k ? "#7ac5ae" : "#c4f88a"}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`,
    )
    .join("");
  function numPoint(n, value) {
    return ((580 * n) / last).toFixed(1) + "," + (104 - value * 1.3).toFixed(1);
  }
  const time = i === last ? "Сейчас" : Math.ceil((last - i) / 3) + " мин назад";
  return `<section class="card network-card"><div class="card-heading"><h2>${icon("Activity")}Сетевая активность</h2>${select(
    "period",
    [
      ["60", "За час"],
      ["15", "За 15 мин"],
    ],
    u.period,
    "Период графика",
  )}</div>
    <div class="metrics">${["Загрузка", "Отдача"].map((label, k) => `<div><span class="metric-label">${icon(k ? "ArrowUpRight" : "ArrowDownLeft")} ${label}</span><div class="number"><b>${num(point[k])}</b><small>МБ/с</small></div></div>`).join("")}</div>
    <svg id="graph" role="img" aria-label="Скорость загрузки и отдачи, МБ/с" viewBox="0 0 580 104" preserveAspectRatio="none"><defs><linearGradient id="chart-fill" x2="0" y2="1"><stop stop-color="#b6ea77" stop-opacity=".25"/><stop offset="1" stop-color="#b6ea77" stop-opacity=".02"/></linearGradient></defs>${grid}<polygon points="0,104 ${area} 580,104" fill="url(#chart-fill)"/>${lines}<line x1="${x}" x2="${x}" y1="0" y2="104" stroke="#c4f88a" stroke-dasharray="3 5"/></svg>
    <input type="range" id="scrub" aria-label="Момент на графике" aria-valuetext="${time}" min="0" max="${last}" value="${i}"><div id="ticks"><span>−${period} мин</span><span>${time}</span></div></section>`;
}
function dashboard(s) {
  return (
    shelf(s) +
    `<section class="quick-actions"><h2>Быстрые действия</h2><div>${button("quickCopy", icon("FileArchive") + "Скопировать файл")}${button("find", icon("Search") + "Найти файл")}${button("page", icon("Check") + "Проверить SHA-256", "integrity")}</div></section>
    <div class="top-grid">${network(s)}${queue(s, true)}</div>`
  );
}
function fileSearch(s) {
  const u = s.ui,
    d = byId(s.disks, u.disk),
    q = u.fileQuery.trim().toLowerCase(),
    groups = new Map(),
    counts = new Map();
  for (const f of s.files) {
    counts.set(f.contentId, (counts.get(f.contentId) || 0) + 1);
    const carrier = diskOf(s, f);
    if ((d && f.diskId !== d.id) || ![pathOf(s, f), carrier.label, carrier.location].join(" ").toLowerCase().includes(q))
      continue;
    if (!groups.has(f.contentId) || !available(s, diskOf(s, groups.get(f.contentId)))) groups.set(f.contentId, f);
  }
  const rows = Array.from(groups.values(), (f) =>
    button(
      "file",
      `<i>${icon(f.platform ? "Gamepad2" : f.type === "Видео" ? "Film" : "File")}</i><span><b>${esc(f.name)}</b><small>${esc(pathOf(s, f))}</small></span><em>${esc(diskOf(s, f).label)} · копий: ${counts.get(f.contentId)}</em><small>${bytes(f.sizeBytes)}</small>`,
      f.id,
      "file-line",
    ),
  ).join("");
  return card(
    u.page === "index" ? "Поиск по индексу" : "Файлы на носителях",
    `<div class="catalog-controls">${search("catalog-q", "Имя файла или путь", u.fileQuery)}${field("disk-filter", "Носитель", [["", "Все носители"], ...s.disks.map((d) => [d.id, d.label])], u.disk)}</div>
    ${d ? `<div class="info-strip">${esc(d.label)} · ${available(s, d) ? esc(d.fs) + " · " + (d.fs === "NTFS" ? "снимок MFT" : "обход папок") + (d.lastScan ? " · обновлён " + dateText(d.lastScan) : "") : "Не в сети · " + esc(d.location) + " · " + dateText(d.lastSeen)} ${available(s, d) ? button("reindex", "Обновить индекс", d.id) : ""}</div>` : ""}
    ${s.loading ? skeleton("Загрузка индекса", 4) : rows || empty("Ничего не найдено в каталоге.")}`,
  );
}
function copyReason(s, file, target) {
  const source = diskOf(s, file);
  if (!available(s, source)) return "Исходный носитель не в сети. Выберите подключённую копию.";
  if (!target) return "Выберите устройство назначения.";
  if (!available(s, target)) return "Устройство назначения не в сети.";
  if (target.id === source.id || target.kind === "optical") return "Выберите другой носитель с возможностью записи.";
  if (target.id === s.gamePool && !file.platform) return "Игровой SSD предназначен для игр.";
  if (s.files.some((f) => f.diskId === target.id && f.dir === file.dir && f.name === file.name))
    return "В этой папке уже есть файл с таким именем.";
  if (target.freeBytes < file.sizeBytes)
    return "Недостаточно места. Требуется " + bytes(file.sizeBytes) + ", свободно " + bytes(target.freeBytes) + ".";
  return "";
}
function fileDetails(s) {
  const back = button("backToFiles", "Вернуться в каталог");
  if (s.loading) return skeleton("Загрузка деталей файла", 5);
  const f = byId(s.files, s.ui.fileId);
  if (!f) return card("Файл отсутствует", empty("В текущем снимке этого файла нет.") + back);
  const d = diskOf(s, f),
    online = available(s, d);
  const copies = s.files.filter((c) => c.contentId === f.contentId);
  const sum = s.manifests[f.id] || s.checksums[f.contentId];
  const targets = s.disks.filter((v) => v.id !== d.id && v.kind !== "optical");
  const target = byId(targets, s.ui.form.copyTarget);
  const reason = copyReason(s, f, target);
  const pending = s.tasks.some((j) => ["running", "paused"].includes(j.state) && j.operation?.fileId === f.id);
  const options = [
    ["", "Выберите носитель"],
    ...targets.map((v) => [v.id, v.label + " · " + (available(s, v) ? bytes(v.freeBytes) + " свободно" : "Не в сети")]),
  ];
  const tracks = (f.tracks || [])
    .map(
      (t) =>
        `<div class="track-detail"><span>${icon(t.kind === "audio" ? "Music2" : "Film")}${t.kind === "audio" ? "Аудио" : "Видео"}</span><b>${esc(t.codec)}</b><small>${esc(t.details)}</small></div>`,
    )
    .join("");
  const relatedCopy = s.tasks.find(
    (j) =>
      j.kind === "copy" &&
      ["running", "paused"].includes(j.state) &&
      byId(s.files, j.operation?.fileId)?.contentId === f.contentId,
  );
  const related = s.tasks.find((j) => j.state === "error" && byId(s.files, j.operation?.fileId)?.contentId === f.contentId);
  return `<div class="detail-back">${back}</div><div class="detail-grid"><div>${card(
    esc(f.name),
    `<dl class="file-facts"><div><dt>Путь</dt><dd>${esc(pathOf(s, f))}</dd></div><div><dt>Размер</dt><dd>${bytes(f.sizeBytes)}</dd></div><div><dt>Носитель</dt><dd>${esc(d.label)} · ${online ? "В сети" : "Не в сети"}</dd></div></dl>
    <h3>Контрольная сумма SHA-256</h3>${sum ? `<code class="checksum">${esc(sum)}</code>` : empty("Для этого файла ещё нет манифеста.")}
    <div class="file-actions">${button("fileOp", "Перенос и копирование", "move", "secondary-action", online ? "" : "disabled")}${button("fileOp", "Проверить SHA-256", "integrity", "secondary-action", online ? "" : "disabled")}${button("fileOp", "Отправить через LocalSend", "localsend", "secondary-action", online ? "" : "disabled")}</div>`,
  )}
    ${card("Дорожки", tracks || empty(["Видео", "Музыка"].includes(f.type) ? "Дорожки ещё не проиндексированы." : "У этого типа файла нет медиадорожек."))}</div>
    <div>${card(
      "Где лежат копии",
      `<div class="copy-list">${copies
        .map((c) => {
          const v = diskOf(s, c);
          return button(
            "file",
            `<b>${esc(v.label)}</b><span>${available(s, v) ? "В сети · " + esc(hostOf(s, v).name) : "Не в сети · " + esc(v.location)}</span><small>${esc(pathOf(s, c))}</small>`,
            c.id,
            "copy-place",
            `aria-pressed="${c === f}"`,
          );
        })
        .join("")}</div>`,
    )}
    ${card(
      "Скопировать на другое устройство",
      `${field("copyTarget", "Назначение", options, target?.id || "")}
      <p class="route-preview ${(target && reason) || !online ? "blocked" : ""}">${esc(pending ? "Для этой копии уже выполняется задание." : reason || "После записи будет выполнена сверка SHA-256.")}</p>
      ${button("copyDetail", "Скопировать", "", "primary", reason || pending ? "disabled" : "")}
      ${related ? `<p class="error-message">${esc(related.title)} · ${esc(related.error)}</p>` : ""}
      ${relatedCopy ? `<p class="task-route">${esc(relatedCopy.title)} · ${relatedCopy.state === "paused" ? "На паузе" : "Выполняется"} · ${num(relatedCopy.progress)}%</p>` : ""}
      ${pending || related || relatedCopy ? button("page", "Открыть очередь", "jobs") : ""}`,
    )}</div></div>`;
}
function torrentsPage(s) {
  const u = s.ui,
    items = s.torrents.filter(
      (t) =>
        (!u.host || diskOf(s, t).host === u.host) &&
        (!u.status || t.state === u.status) &&
        t.name.toLowerCase().includes(u.torrentQuery.trim().toLowerCase()),
    );
  const tabs = Object.entries({ "": "Все", ...torrentStates })
    .map(([key, label]) => button("status", label, key, "", `aria-pressed="${key === u.status}"`))
    .join("");
  const rows = items
    .map((t) => {
      const d = diskOf(s, t),
        rate = available(s, d) ? (t.state === "down" ? t.down : t.state === "seed" ? t.up : 0) : 0;
      return `<tr class="torrent-row"><td>${button("torrent", `<span class="tile">${icon(fileTypes[t.kind][1])}</span><span><strong>${esc(t.name)}</strong><small>${bytes(t.sizeBytes)}</small></span>`, t.id, "item")}</td>
      <td class="host-cell">${esc(hostOf(s, d).name)}</td><td><span class="pill ${t.state}">${available(s, d) ? torrentStates[t.state] : "Не в сети"}</span></td><td><div class="progress">${t.progress}%${meter(t.progress, t.name)}</div></td>
      <td class="rate-cell rate">${rate ? num(rate) + " МБ/с" : "—"}</td><td>${button("torrent", icon("ChevronRight"), t.id, "row-more", `aria-label="Подробности: ${esc(t.name)}"`)}</td></tr>`;
    })
    .join("");
  return `<section id="transfers" class="card"><div class="card-heading"><h2>${icon("ArrowDownUp")}Раздачи <span class="count">${items.length}</span></h2>${search("query", "Поиск по имени", u.torrentQuery)}</div>
    <div class="filters"><div class="tabs">${tabs}</div>${select("host", [["", "Все хосты"], ...s.hosts.map((h) => [h.id, h.name])], u.host, "Хост раздачи")}</div>
    ${s.loading ? skeleton("Загрузка раздач", 4) : rows ? `<div class="table-scroll"><table><thead><tr>${["Название", "Хост", "Статус", "Прогресс", "Скорость", ""].map((t) => `<th>${t}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : empty("Раздач по этим условиям нет. " + button("resetTorrents", "Сбросить фильтры"))}</section>`;
}
function scheduler(s) {
  return (
    s.disks
      .map((d) => {
        const tasks = s.torrents
          .filter((t) => t.diskId === d.id && t.progress < 100)
          .sort((a, b) => Number(b.state === "down") - Number(a.state === "down") || a.rank - b.rank);
        if (!tasks.length) return "";
        return card(
          esc(d.label),
          `<p class="capacity-label">${esc(hostOf(s, d).name)} · ${available(s, d) ? "занято слотов " + tasks.filter((t) => t.state === "down").length + " / 1" : "Не в сети"}</p>` +
            tasks
              .map(
                (t) =>
                  `<div class="schedule-line"><b>${esc(t.name)}</b><span class="pill ${t.state}">${torrentStates[t.state]}</span>${available(s, d) ? (t.state === "down" ? button("finish", "Завершить в демо", t.id) : t.state === "wait" ? button("next", "Следующим", t.id) : button("torrent", "Открыть", t.id)) : ""}</div>`,
              )
              .join(""),
        );
      })
      .join("") || empty("Загрузок в очереди нет.")
  );
}
function gameShelf(s) {
  const platforms = ["Все", "Windows", "macOS", "Switch", "PSP", "PS2", "PS4"];
  const tabs = platforms
    .map((p) => button("platform", p, p, "secondary-action", `aria-pressed="${s.ui.platform === p}"`))
    .join("");
  const games = s.files.filter(
    (f) => f.platform && f.id === f.contentId && (s.ui.platform === "Все" || s.ui.platform === f.platform),
  );
  return `<div class="platforms">${tabs}</div><div class="game-grid">${
    games
      .map((f) => {
        const copy = s.files.find((c) => c.original === f.id),
          disk = diskOf(s, copy || f);
        return `<article class="card game-card"><div class="game-cover cover-${esc(f.id)}">${icon("Gamepad2")}<b>${esc(f.name)}</b></div><div class="game-meta"><small>${esc(f.platform)} · ${bytes(f.sizeBytes)}</small><p>${esc(disk.label)} · ${available(s, disk) ? "В сети" : "Не в сети"}</p>${button("game", copy ? "Запустить" : f.platform === "macOS" ? "Открыть карточку" : "Подготовить на SSD", f.id, "secondary-action", available(s, disk) ? "" : "disabled")}</div></article>`;
      })
      .join("") || empty("Игр для этой платформы пока нет.")
  }</div>`;
}
const operationTitles = {
  move: ["Файлы и раздачи", "Поставить в очередь"],
  integrity: ["Контрольные суммы", "Проверить SHA-256"],
  localsend: ["Передача LocalSend", "Поставить передачу в очередь"],
  optical: ["Мастер оптического диска", "Поставить задание в очередь"],
};

function operationModel(s) {
  const u = s.ui,
    form = u.form,
    page = u.page;
  const files = s.files.filter((f) => available(s, diskOf(s, f)));
  const file = byId(files, form.source) || files[0];
  if (!file) return { files, reason: "Нет доступных файлов на подключённых носителях." };
  const src = diskOf(s, file),
    writeable = s.disks.filter((d) => available(s, d) && d.kind !== "optical");
  const targets = writeable.filter((d) => d.id !== src.id);
  const target = byId(targets, form.dest) || targets.find((d) => d.host === src.host && d.id !== s.gamePool) || targets[0];
  const mode = form.mode || (file.torrentId ? "Перенос раздачи" : "Копирование");
  const receive = form.direction === "Принять",
    recvDisks = writeable.filter((d) => d.id !== s.gamePool);
  const inbox = byId(recvDisks, form.inbox) || recvDisks[0];
  const peers = [...s.hosts, ...s.devices].filter((h) => h.id !== src.host && h.online);
  const peer = byId(peers, form.peer) || peers[0];
  const medium = form.medium || "DVD-5",
    opt = form.opt || "Собрать ISO",
    art = opt === "Рисунок на поверхности";
  const other = byId(files, form.compare);
  let reason = "",
    plan = "";
  if (page === "move") {
    if (!target) reason = "Нет подключённого диска назначения.";
    else if (mode === "Копирование") reason = copyReason(s, file, target);
    else if (mode === "Перенос раздачи" && src.host !== target.host) reason = "Выберите диск на том же хосте.";
    else if (target.id === s.gamePool && !file.platform) reason = "Игровой SSD предназначен для игр.";
    else if (target.freeBytes < (file.allocatedBytes ?? file.sizeBytes)) reason = "Недостаточно свободного места.";
    if (!reason) plan = src.label + " → " + target.label + " · " + bytes(file.sizeBytes);
  } else if (page === "integrity") plan = other ? file.name + " ↔ " + other.name : "Манифест · " + file.name;
  else if (page === "localsend") {
    if (!peer || (receive && !inbox)) reason = "Устройство назначения недоступно.";
    else if (receive && inbox.freeBytes < file.sizeBytes) reason = "Недостаточно свободного места.";
    else plan = receive ? peer.name + " → " + inbox.label + " / Inbox" : hostOf(s, src).name + " → " + peer.name;
  } else if (page === "optical") {
    if (!available(s, byId(s.disks, s.imageDisk))) reason = "Нет связи с узлом оптического привода.";
    else if (art && medium === "DVD-DL") reason = "Для рисунка нужен однослойный носитель.";
    else if (!art && file.sizeBytes > mediaCapacity[medium]) reason = "Набор больше ёмкости " + medium + ".";
    else plan = (art ? "DiscImageStudio" : file.name) + " · " + medium + " · " + bytes(mediaCapacity[medium]);
  }
  return {
    files,
    file,
    src,
    targets,
    target,
    mode,
    other,
    peers,
    peer,
    receive,
    inbox,
    recvDisks,
    medium,
    opt,
    art,
    reason,
    plan,
  };
}
function operationPage(s) {
  const page = s.ui.page,
    m = operationModel(s),
    form = s.ui.form;
  const [title, submit] = operationTitles[page];
  const fileOptions = (fs) => fs.map((f) => [f.id, f.name + " · " + diskOf(s, f).label]);
  if (!m.file) return card(title, empty(m.reason));
  let fields = "",
    placement = "";
  if (page === "move") {
    const modes = m.file.torrentId ? ["Перенос раздачи", "Копирование"] : ["Копирование", "Перенос файла"];
    fields =
      field("mode", "Операция", modes, m.mode) +
      field(
        "dest",
        "Диск назначения",
        m.targets.map((d) => [d.id, d.label]),
        m.target?.id,
      );
    placement = `<div class="drop-source" draggable="true" id="grab-file">${icon("FileArchive")}${esc(m.file.name)}<small>Перетащите на диск или выберите его нажатием</small></div><div class="drop-grid">${m.targets.map((d) => button("dest", icon("HardDrive") + esc(d.label) + `<small>${bytes(d.freeBytes)} свободно</small>`, d.id, "drop-target", `aria-pressed="${d === m.target}"`)).join("")}</div>`;
  } else if (page === "integrity") {
    fields = field(
      "compare",
      "Сверить с копией",
      [["", "Только записать манифест"], ...fileOptions(m.files.filter((f) => f !== m.file))],
      form.compare || "",
    );
  } else if (page === "localsend") {
    fields =
      field("direction", "Направление", ["Отправить", "Принять"], m.receive ? "Принять" : "Отправить") +
      field(
        "peer",
        "Устройство",
        m.peers.map((h) => [h.id, h.name]),
        m.peer?.id,
      );
    if (m.receive)
      fields += field(
        "inbox",
        "Папка приёма",
        m.recvDisks.map((d) => [d.id, d.label + " / Inbox"]),
        m.inbox?.id,
      );
  } else {
    fields =
      field("opt", "Операция", ["Собрать ISO", "Записать и проверить", "Рисунок на поверхности"], m.opt) +
      field("medium", "Носитель", Object.keys(mediaCapacity), m.medium);
    if (m.art)
      fields += `<label class="field">Рисунок на диск<input type="file" id="art-file" accept="image/png,image/jpeg,image/webp"></label><div class="surface-preview">${form.artURL ? `<img src="${esc(form.artURL)}" alt="Предпросмотр рисунка">` : "Склад"}</div>`;
  }
  let result = card(
    title,
    `<div class="form-grid">${m.art && page === "optical" ? "" : field("source", "Источник из каталога", fileOptions(m.files), m.file.id)}${fields}</div>${placement}<div class="route-preview ${m.reason ? "blocked" : ""}">${esc(m.reason || m.plan)}</div>${button("run", icon("Play") + submit, "", "primary", m.reason ? "disabled" : "")}`,
  );
  if (page === "integrity")
    result +=
      card(
        "Манифесты SHA-256",
        Object.entries(s.manifests)
          .map(([id, hash]) => `<div class="info-strip">${esc(byId(s.files, id)?.name)}<code>${esc(hash)}</code></div>`)
          .join("") || empty("Манифестов пока нет."),
      ) + s.comparisons.map((item) => `<p class="info-strip">${esc(item)}</p>`).join("");
  return result;
}
function policyPage(s) {
  const cat = s.ui.category,
    r = s.rules[cat],
    ntfs = r.target === "group" || byId(s.disks, r.target)?.fs === "NTFS";
  const after = [
    "Без обработки",
    ...(["Фильмы", "Сериалы"].includes(cat) ? ["HandBrake"] : []),
    ...(cat === "Игры" && ntfs ? ["Сжатие NTFS"] : []),
  ];
  const options = [
    ["group", "Любой архивный HDD со свободным местом"],
    ...s.disks.filter((d) => d.kind !== "optical" && d.id !== s.gamePool).map((d) => [d.id, d.label]),
  ];
  return card(
    "Назначение контента",
    `<div class="form-grid">${field("category", "Категория", Object.keys(s.rules), cat)}${field("rule-target", "Куда размещать", options, r.target)}
    <label class="field">Папка<input id="folder" value="${esc(r.folder)}"></label>${field("rule-index", "Индексация", ["Нет", "Обход папок", ...(ntfs ? ["NTFS MFT"] : [])], r.index)}${field("after", "После загрузки", after, r.after)}</div>
    <div class="file-actions">${button("dry", "Пробный прогон", "", "primary", Object.values(s.rules).every((r) => r.folder.trim()) ? "" : "disabled")}${button("auto", s.automation ? "Выключить автоматику" : "Включить автоматику", "", "secondary-action", s.previewFresh ? "" : "disabled")}</div>
    ${
      s.previewFresh
        ? Object.entries(s.rules)
            .map(
              ([label, r]) =>
                `<div class="policy-line"><b>${esc(label)}</b><span>${esc(byId(s.disks, r.target)?.label || "Группа HDD")} / ${esc(r.folder)}</span><small>${esc(r.index)} · ${esc(r.after)}</small></div>`,
            )
            .join("")
        : empty("Изменения требуют нового пробного прогона.")
    }`,
  );
}
function modalView(s) {
  const { kind, id } = s.ui.modal;
  let title = "",
    content = "";
  if (kind === "launch") {
    const f = byId(s.files, id);
    title = f.name;
    content = `<p>Демозапуск · ${esc(pathOf(s, f))}</p>`;
  } else if (kind === "torrent") {
    const t = byId(s.torrents, id),
      d = diskOf(s, t);
    title = t.name;
    content =
      `<dl>${[
        ["Хост", hostOf(s, d).name],
        ["Носитель", d.label],
        ["Статус", torrentStates[t.state]],
        ["Размер", bytes(t.sizeBytes)],
        ["Прогресс", t.progress + "%"],
      ]
        .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
        .join("")}</dl>` +
      button(
        "toggleTorrent",
        t.state === "pause" ? "Продолжить" : "Приостановить",
        id,
        "primary",
        available(s, d) ? "" : "disabled",
      );
    if (available(s, d) && s.files.some((f) => f.torrentId === id))
      content += button("moveTorrent", "Перенести раздачу", id);
  } else if (kind === "add") {
    title = "Добавить торрент";
    const hosts = s.hosts.filter(
      (h) =>
        h.online && s.disks.some((d) => available(s, d) && d.host === h.id && d.kind !== "optical" && d.id !== s.gamePool),
    );
    const h = byId(hosts, s.ui.form.addHost) || hosts[0];
    const disks = s.disks.filter((d) => available(s, d) && d.host === h?.id && d.kind !== "optical" && d.id !== s.gamePool);
    content = `<form id="add-form"><label>Magnet-ссылка<input id="magnet" value="${esc(s.ui.form.magnet)}" required placeholder="magnet:?xt=urn:btih:…"></label>
      ${field(
        "addHost",
        "Хост",
        hosts.map((h) => [h.id, h.name]),
        h?.id,
      )}${field(
        "addDisk",
        "Сохранить на носитель",
        disks.map((d) => [d.id, d.label]),
        s.ui.form.addDisk || disks[0]?.id,
      )}
      <button class="primary" type="submit">Добавить</button></form>`;
  }
  return `<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${button("close", icon("X"), "", "icon-button", 'aria-label="Закрыть"')}</div>${content}</div>`;
}
function screen(s) {
  const page = s.ui.page;
  if (page === "overview") return dashboard(s);
  if (page === "details") return fileDetails(s);
  if (page === "devices") return devicesPage(s);
  if (page === "jobs") return queue(s);
  if (s.loading) return skeleton("Загрузка раздела", 4);
  if (page === "drives" || page === "index") return fileSearch(s);
  if (page === "torrents") return torrentsPage(s);
  if (page === "games") return gameShelf(s);
  if (page === "scheduler") return scheduler(s);
  if (page === "policies") return policyPage(s);
  return operationPage(s);
}
