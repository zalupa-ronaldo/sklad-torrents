"use strict";

// View helpers take a snapshot; they never query or mutate the document.
const pages = {
  overview: ["Диспетчер", "LayoutDashboard", "Диски, файлы и обработка в локальной сети."],
  drives: ["Все файлы", "HardDrive", "Поиск по снимкам всех носителей, включая отключённые."],
  torrents: ["Торренты", "ArrowDownUp", "Раздачи qBittorrent на ваших хостах."],
  scheduler: ["Планировщик", "Clock3", "Одна активная загрузка на физический диск."],
  jobs: ["Задания", "ListChecks", "Ход операций на ваших хостах."],
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
const torrentStates = {
  down: "Загрузка",
  seed: "Раздача",
  pause: "Пауза",
  wait: "В очереди",
  check: "Проверка",
  move: "Перемещение",
  error: "Ошибка",
  missing: "Файлы не найдены",
};
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
const byId = (list, id) => (list || []).find((row) => row && row.id === id);
const diskOf = (s, f) => (f && f.diskId ? byId(s.disks, f.diskId) : undefined);
function hostOf(s, d) {
  if (!d) return { id: "", name: "Хост не сообщён", online: false };
  const host = d.host ? byId(s.hosts, d.host) : undefined;
  if (host) return host;
  return { id: d.host || "", name: d.host || "Хост не сообщён", online: Boolean(d.online) };
}
const available = (s, d) => Boolean(d?.online && hostOf(s, d).online);
const pathOf = (s, f) => {
  if (f?.path) return f.path;
  const disk = diskOf(s, f);
  return (disk?.mount || "") + (f?.dir || "") + (f?.name || "");
};
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
    .map(([key, [label, symbol]]) => {
      const active = s.ui.page === key;
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
    <div class="host-head"><p class="caption">Хосты</p><span class="count">${s.hosts.length}</span></div><nav aria-label="Хосты">${s.hosts.map((h) => button("host", icon(String(h.id).includes("mac") ? "Laptop" : "Monitor") + esc(h.name) + `<small class="host-state">${h.online ? "В сети" : "Нет связи"}</small>`, h.id, "")).join("")}</nav></div>
    <div class="side-foot">${icon("Network")}<div>Локальная сеть<small>${s.demo ? "Деморежим" : '<a href="/legacy">Прежняя панель</a>'}</small></div></div>`;
}
function topbar(s) {
  return `${button("menu", icon("Menu"), "", "icon-button", `id="menu" aria-label="Открыть навигацию" aria-controls="sidebar" aria-expanded="${s.ui.menu}"`)}
  <span class="breadcrumb">Рабочее пространство</span><i class="breadcrumb">${icon("ChevronRight")}</i><strong>${pages[s.ui.page][0]}</strong>
  <span class="online">В сети · ${s.hosts.filter((h) => h.online).length} / ${s.hosts.length}</span>
  ${s.demo ? `<label class="scenario-label">Демо ${select("scenario", s.scenarioOptions, s.scenario, "Демосостояние")}</label>` : ""}`;
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
            s.loading || (s.demo ? !s.disks.some((d) => available(s, d)) : !(s.torrentHosts || []).some((h) => h.online))
              ? "disabled"
              : "",
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
  const knownKind = s.disks.some((d) => families[d.kind]);
  const cards = !s.disks.length
    ? ""
    : !knownKind
      ? empty("Тип носителя не сообщается.")
      : Object.entries(families)
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
      const typeLabel = families[d.kind] ? families[d.kind][0] : "—";
      return button(
        "disk",
        `<span class="carrier-type">${typeLabel}</span><span class="carrier-label"><b>${esc(d.label)}</b><small>${esc(detail)}</small></span><span class="connect-state ${online ? "" : "off"}">${online ? "В сети" : "Не в сети"}</span>`,
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
function queue(s, compact = false) {
  const rows = (compact ? s.tasks.slice(0, 2) : s.tasks)
    .map((j) => {
      const label =
        { running: "Выполняется", paused: "На паузе", error: "Ошибка", done: "Готово", queued: "В очереди", cancelled: "Отменено" }[
          j.state
        ] || "Состояние не сообщается";
      const active = ["running", "paused", "queued"].includes(j.state);
      const pct = typeof j.progress === "number" ? j.progress : null;
      const hostName = byId(s.hosts, j.host)?.name || j.host || "Хост не сообщён";
      const metrics =
        j.state === "running"
          ? `<span>${j.bytesPerSec == null ? "—" : bytes(j.bytesPerSec) + "/с"} · осталось ${j.etaSec == null ? "—" : Math.ceil(j.etaSec) + " с"}</span>`
          : "";
      const sha = j.sha256
        ? `<p class="sha">SHA-256 ${j.sha256.verified === true ? "совпала" : j.sha256.verified === false ? "различается" : "без сверки"}${j.sha256.source ? " · " + esc(j.sha256.source) : ""}</p>`
        : "";
      return `<article class="job-row ${j.state || ""}" data-job="${esc(j.id)}"><div class="job-body"><b>${esc(j.title)}</b><small>${esc(hostName)} · <strong>${label}</strong></small>
      ${active && pct != null ? meter(pct, j.title) : ""}<div class="job-metrics">${active ? (pct == null ? "—" : num(pct) + "%") : ""} ${metrics}</div>
      ${sha}
      ${j.error ? `<p class="error-message">${esc(j.error)}</p>` : ""}<div class="job-actions">${active ? button("pause", j.state === "paused" ? "Продолжить" : "Пауза", j.id) + button("cancel", "Отмена", j.id) : j.state === "error" ? button("retry", "Повторить", j.id) : ""}</div></div></article>`;
    })
    .join("");
  return `<section class="card queue-card"><div class="card-heading"><h2>${icon("ListChecks")}Очередь задач</h2>${compact ? button("page", "Все задания", "jobs") : ""}</div>${s.loading ? skeleton("Загрузка очереди", 2) : rows || empty("В очереди нет задач.")}</section>`;
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
    if (!carrier) continue;
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
    ${d ? `<div class="info-strip">${esc(d.label)} · ${available(s, d) ? esc(d.fs || "файловая система не сообщена") + (d.fs === "NTFS" ? " · снимок MFT" : d.fs ? " · обход папок" : "") + (d.lastScan ? " · обновлён " + dateText(d.lastScan) : "") : "Не в сети · " + (d.location ? esc(d.location) : "место не сообщается") + " · " + dateText(d.lastSeen)} ${s.demo && available(s, d) ? button("reindex", "Обновить индекс", d.id) : ""}</div>` : ""}
    ${s.catalogError ? `<p class="error-message">${esc(s.catalogError)}</p>` : ""}
    ${s.loading ? skeleton("Загрузка индекса", 4) : rows || empty(!s.demo && !q && !d ? "Введите имя файла. Поиск идёт по каталогу панели." : "Ничего не найдено в каталоге.")}`,
  );
}
function torrentsPage(s) {
  const u = s.ui,
    hostChoices = s.torrentHosts && s.torrentHosts.length ? s.torrentHosts : s.hosts,
    items = s.torrents.filter(
      (t) =>
        (!u.host || t.hostId === u.host || diskOf(s, t)?.host === u.host) &&
        (!u.status || t.state === u.status) &&
        t.name.toLowerCase().includes(u.torrentQuery.trim().toLowerCase()),
    );
  const tabs = Object.entries({ "": "Все", ...torrentStates })
    .map(([key, label]) => button("status", label, key, "", `aria-pressed="${key === u.status}"`))
    .join("");
  const rows = items
    .map((t) => {
      const d = diskOf(s, t);
      const offlineDisk = Boolean(d && !available(s, d));
      const rate = offlineDisk ? 0 : t.state === "down" ? t.down : t.state === "seed" ? t.up : 0;
      const hostName = t.hostName || (d ? hostOf(s, d).name : "Хост не сообщён");
      const kindIcon = fileTypes[t.kind] ? fileTypes[t.kind][1] : "File";
      const stateLabel = offlineDisk ? "Не в сети" : torrentStates[t.state] || "Состояние не сообщается";
      const pct = typeof t.progress === "number" ? t.progress : null;
      return `<tr class="torrent-row"><td>${button("torrent", `<span class="tile">${icon(kindIcon)}</span><span><strong>${esc(t.name)}</strong><small>${bytes(t.sizeBytes)}</small></span>`, t.id, "item")}</td>
      <td class="host-cell">${esc(hostName)}</td><td><span class="pill ${esc(t.state || "")}">${esc(stateLabel)}</span></td><td><div class="progress">${pct == null ? "—" : pct + "%"}${pct == null ? "" : meter(pct, t.name)}</div></td>
      <td class="rate-cell rate">${rate ? num(rate) + " МБ/с" : "—"}</td><td>${button("torrent", icon("ChevronRight"), t.id, "row-more", `aria-label="Подробности: ${esc(t.name)}"`)}</td></tr>`;
    })
    .join("");
  return `<section id="transfers" class="card"><div class="card-heading"><h2>${icon("ArrowDownUp")}Раздачи <span class="count">${items.length}</span></h2>${search("query", "Поиск по имени", u.torrentQuery)}</div>
    <div class="filters"><div class="tabs">${tabs}</div>${select("host", [["", "Все хосты"], ...hostChoices.map((h) => [h.id, h.name])], u.host, "Хост раздачи")}</div>
    ${s.loading ? skeleton("Загрузка раздач", 4) : rows ? `<div class="table-scroll"><table><thead><tr>${["Название", "Хост", "Статус", "Прогресс", "Скорость", ""].map((t) => `<th>${t}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : empty("Раздач по этим условиям нет. " + button("resetTorrents", "Сбросить фильтры"))}</section>`;
}
function scheduler(s) {
  return (
    s.disks
      .map((d) => {
        const tasks = s.torrents
          .filter((t) => t.diskId === d.id && t.progress < 100)
          .sort((a, b) => Number(b.state === "down") - Number(a.state === "down") || (a.rank ?? 0) - (b.rank ?? 0));
        if (!tasks.length) return "";
        return card(
          esc(d.label),
          `<p class="capacity-label">${esc(hostOf(s, d).name)} · ${available(s, d) ? "занято слотов " + tasks.filter((t) => t.state === "down").length + " / 1" : "Не в сети"}</p>` +
            tasks
              .map(
                (t) =>
                  `<div class="schedule-line"><b>${esc(t.name)}</b><span class="pill ${t.state}">${torrentStates[t.state] || "Состояние не сообщается"}</span>${s.demo && available(s, d) ? (t.state === "down" ? button("finish", "Завершить в демо", t.id) : t.state === "wait" ? button("next", "Следующим", t.id) : button("torrent", "Открыть", t.id)) : button("torrent", "Открыть", t.id)}</div>`,
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
        const diskLabel = disk ? disk.label : "Диск не найден";
        const diskOnline = Boolean(disk && available(s, disk));
        return `<article class="card game-card"><div class="game-cover cover-${esc(f.id)}">${icon("Gamepad2")}<b>${esc(f.name)}</b></div><div class="game-meta"><small>${esc(f.platform)} · ${bytes(f.sizeBytes)}</small><p>${esc(diskLabel)} · ${diskOnline ? "В сети" : "Не в сети"}</p>${button("game", copy ? "Запустить" : f.platform === "macOS" ? "Открыть карточку" : "Подготовить на SSD", f.id, "secondary-action", diskOnline ? "" : "disabled")}</div></article>`;
      })
      .join("") || empty(!s.demo && !s.files.some((f) => f.platform) ? "Платформа игры в каталоге не сообщается." : "Игр для этой платформы пока нет.")
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
    else if (mode === "Перенос раздачи" && src.host !== target.host) reason = "Выберите диск на том же хосте.";
    else if (target.id === s.gamePool && !file.platform) reason = "Игровой SSD предназначен для игр.";
    else if (target.freeBytes < (file.allocatedBytes ?? file.sizeBytes)) reason = "Недостаточно свободного места.";
    else plan = src.label + " → " + target.label + " · " + bytes(file.sizeBytes);
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
  const keys = Object.keys(s.rules || {});
  if (!keys.length) return card("Назначение контента", empty("Правила раскладки этим ответом не передаются."));
  const cat = keys.includes(s.ui.category) ? s.ui.category : keys[0],
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
  if (kind === "file" || kind === "launch") {
    const f = byId(s.files, id),
      d = diskOf(s, f);
    if (!f || !d) {
      title = "Файл";
      content = empty("Файл или диск не найдены в текущем снимке.");
      return `<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${button("close", icon("X"), "", "icon-button", 'aria-label="Закрыть"')}</div>${content}</div>`;
    }
    title = f.name;
    content =
      kind === "launch"
        ? `<p>Демозапуск · ${esc(pathOf(s, f))}</p>`
        : `<p>${esc(f.type)} · ${bytes(f.sizeBytes)}${f.allocatedBytes ? " · на диске " + bytes(f.allocatedBytes) : ""}</p><h3 class="copies-heading">Где хранится</h3><div class="copy-list">${s.files
            .filter((c) => c.contentId === f.contentId)
            .map((c) => {
              const v = diskOf(s, c);
              if (!v) return "";
              return button(
                "file",
                `<b>${esc(v.label)}</b><span>${available(s, v) ? esc(hostOf(s, v).name) + " · В сети" : "Не в сети · " + esc(v.location) + " · " + dateText(v.lastSeen)}</span><small>${esc(pathOf(s, c))}</small>`,
                c.id,
                "copy-place",
                `aria-pressed="${c.id === id}"`,
              );
            })
            .join("")}</div>
      ${
        available(s, d)
          ? `<div class="file-actions">${[
              ["move", "Перенести или скопировать"],
              ["localsend", "Отправить через LocalSend"],
              ["integrity", "Проверить SHA-256"],
            ]
              .map(([key, label]) => button("fileOp", label, key))
              .join("")}</div>`
          : empty("Копия недоступна · " + esc(d.label))
      }`;
  } else if (kind === "torrent") {
    const t = byId(s.torrents, id),
      d = diskOf(s, t);
    title = t?.name || "Раздача";
    const hostName = t?.hostName || (d ? hostOf(s, d).name : "Хост не сообщён");
    const diskLabel = d ? d.label : "Диск не сопоставлен";
    const pct = typeof t?.progress === "number" ? t.progress + "%" : "—";
    const canToggle = s.demo ? available(s, d) : Boolean(t?.hostId);
    content =
      `<dl>${[
        ["Хост", hostName],
        ["Носитель", diskLabel],
        ["Статус", torrentStates[t?.state] || "Состояние не сообщается"],
        ["Размер", bytes(t?.sizeBytes)],
        ["Прогресс", pct],
      ]
        .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
        .join("")}</dl>` +
      button(
        "toggleTorrent",
        t?.state === "pause" ? "Продолжить" : "Приостановить",
        id,
        "primary",
        canToggle ? "" : "disabled",
      );
    if (s.demo && available(s, d) && s.files.some((f) => f.torrentId === id))
      content += button("moveTorrent", "Перенести раздачу", id);
  } else if (kind === "add" && !s.demo) {
    title = "Добавить торрент";
    const hosts = (s.torrentHosts || []).filter((h) => h.online);
    const h = byId(hosts, s.ui.form.addHost) || hosts[0];
    content = hosts.length
      ? `<form id="add-form"><label>Magnet-ссылка<input id="magnet" value="${esc(s.ui.form.magnet)}" required placeholder="magnet:?xt=urn:btih:…"></label>
      ${field("addHost", "Хост qBittorrent", hosts.map((host) => [host.id, host.name]), h?.id)}
      <label class="field">Каталог сохранения<input id="savePath" value="${esc(s.ui.form.savePath)}" required placeholder="/Volumes/… или D:\\…"></label>
      <button class="primary" type="submit">Добавить</button></form>`
      : empty("Нет хоста qBittorrent в сети.");
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
function liveCopy(s) {
  const files = (s.files || []).filter((f) => f && f.path && f.diskId);
  const dests = s.destinations || [];
  const picked = byId(files, s.ui.form.source) || files[0];
  const dest = byId(dests, s.ui.form.dest) || dests.find((item) => item.online) || dests[0];
  if (s.copyUnavailable) return card("Копирование", empty("Очередь копирования не ответила."));
  if (!files.length) return card("Копирование", empty("Сначала найдите файл в разделе «Все файлы». Путь берётся из каталога."));
  if (!dests.length) return card("Копирование", empty("Назначений для копирования нет."));
  return card(
    "Копирование с SHA-256",
    `${field("source", "Файл", files.map((f) => [f.id, f.name]), picked?.id)}${field("dest", "Куда", dests.map((item) => [item.id, item.label + (item.online ? "" : " · не в сети")]), dest?.id)}
    <p class="empty-hint">${esc(picked?.path || "")}${dest ? " → " + esc(dest.label) : ""}</p>
    ${button("liveCopy", "Копировать", "", "primary", picked && dest && dest.online ? "" : "disabled")}`,
  );
}
function integrityLive(s) {
  const rows = (s.tasks || [])
    .filter((job) => job.sha256)
    .map((job) => {
      const verdict = job.sha256.verified === true ? "совпала" : job.sha256.verified === false ? "различается" : "без сверки";
      const hash = job.sha256.source || job.sha256.dest || "";
      return `<p class="policy-line"><b>${esc(job.title)}</b><span>SHA-256 ${esc(verdict)}</span><small>${esc(hash)}</small></p>`;
    })
    .join("");
  return card("SHA-256", rows || empty("Суммы появляются у задачи копирования, когда панель их посчитала."));
}
function screen(s) {
  const page = s.ui.page;
  if (page === "overview") return dashboard(s);
  if (page === "jobs") return queue(s);
  if (s.loading) return skeleton("Загрузка раздела", 4);
  if (!s.demo && page === "move") return liveCopy(s);
  if (!s.demo && page === "integrity") return integrityLive(s);
  if (!s.demo && (page === "localsend" || page === "optical"))
    return card(pages[page][0], empty("Этот раздел не заполняется ответом панели. Прежние экраны открыты на /legacy."));
  if (page === "drives" || page === "index") return fileSearch(s);
  if (page === "torrents") return torrentsPage(s);
  if (page === "games") return gameShelf(s);
  if (page === "scheduler") return scheduler(s);
  if (page === "policies") return policyPage(s);
  return operationPage(s);
}

globalThis.SkladWorkbench = { screen, shelf, queue, torrentsPage, sidebar, dashboard, fileSearch, policyPage };
