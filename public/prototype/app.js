"use strict";

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const states = {
  down: ["Загрузка", "ArrowDownLeft"], seed: ["Раздача", "ArrowUpRight"], pause: ["Пауза", "Pause"]
};
const kinds = {
  image: ["Образ диска", "Disc3", "#303623", "#ccdc94"],
  video: ["Видео", "Film", "#302c39", "#c7aedf"],
  data: ["Данные", "Database", "#26343b", "#97c6da"],
  audio: ["Аудио", "Music2", "#372e27", "#deba94"],
  archive: ["Архив", "FileArchive", "#2b3430", "#a7c7b7"]
};
const seeds = [
  ["Ubuntu 24.04.2 Desktop", "image", "5,9 ГБ", "Mac mini", "down", 68, 28.4, 0],
  ["Big Buck Bunny · 4K", "video", "3,2 ГБ", "Windows PC", "down", 42, 20.2, 0],
  ["OpenStreetMap · Europe", "data", "31,6 ГБ", "Windows PC", "seed", 100, 0, 8.6],
  ["Blender Demo Files", "archive", "8,4 ГБ", "Mac mini", "seed", 100, 0, 4.2],
  ["Musopen Collection", "audio", "2,8 ГБ", "Mac mini", "pause", 36, 0, 0],
  ["Debian 13 · netinst", "image", "784 МБ", "Windows PC", "seed", 100, 0, 2.4]
];
const torrents = seeds.map(([name, kind, size, host, state, percent, down, up], id) =>
  ({ id, name, kind, size, host, state, percent, down, up }));
const pages = {
  overview: ["Диспетчер", "Диспетчер склада", "Диски, файлы и обработка в локальной сети."],
  torrents: ["Торренты", "Торренты", "Раздачи qBittorrent на Mac mini и Windows PC."],
  drives: ["Полка дисков", "Полка дисков", "Ёмкость и свободное место на подключённых томах."],
  jobs: ["Очередь задач", "Очередь задач", "Фоновые операции на ваших хостах."]
};
let page = "overview";
let filter = "";
let noticeTimer;
let returnFocus;

function tile(kind) {
  const [, symbol, bg, fg] = kinds[kind];
  return `<span class="tile" style="--tile-bg:${bg};--tile-fg:${fg}">${icon(symbol)}</span>`;
}
function pill(state) {
  const [label, symbol] = states[state];
  return `<span class="pill ${state}">${icon(symbol)}${label}</span>`;
}
function track(percent, color = "var(--lime)") {
  return `<div class="track"><span style="width:${percent}%;background:${color}"></span></div>`;
}
function renderRows() {
  const host = $("host").value;
  const query = $("query").value.trim().toLocaleLowerCase("ru");
  const items = torrents.filter((item) => (!filter || item.state === filter) &&
    (!host || item.host === host) && item.name.toLocaleLowerCase("ru").includes(query));
  $("rows").innerHTML = items.map((item) => {
    const name = escapeHtml(item.name);
    const speed = item.state === "down" ? item.down : item.state === "seed" ? item.up : 0;
    const color = { down: "var(--lime)", seed: "var(--aqua)", pause: "#c3ad85", wait: "#a7b4c1" }[item.state];
    return `<tr class="torrent-row">
      <td><button class="item" data-detail="${item.id}">${tile(item.kind)}<span><strong>${name}</strong><small>${kinds[item.kind][0]} · ${item.size}</small></span></button></td>
      <td class="host-cell">${item.host}</td><td>${pill(item.state)}</td>
      <td><div class="progress">${item.percent}%${track(item.percent, color)}</div></td>
      <td class="rate-cell rate">${speed ? num(speed) + " МБ/с" : "—"}</td>
      <td><button class="row-more" data-detail="${item.id}" aria-label="Подробности: ${name}">${icon("ChevronRight")}</button></td></tr>`;
  }).join("");
  $("empty").hidden = items.length > 0;
  $("total").textContent = items.length;
  $("nav-count").textContent = torrents.length;
  document.querySelector(".tabs").innerHTML = [["", "Все"], ["down", "Загрузка"], ["seed", "Раздача"], ["pause", "Пауза"], ["wait","В очереди"]]
    .map(([key, label]) => `<button data-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join("");
}

function renderChart() {
  const download = torrents.reduce((sum, item) => sum + (item.state === "down" ? item.down : 0), 0);
  const upload = torrents.reduce((sum, item) => sum + (item.state === "seed" ? item.up : 0), 0);
  $("down").textContent = num(download);
  $("up").textContent = num(upload);
  // Fixed sample history for both views. The short view shows its last quarter.
  const history = Array.from({ length: 181 }, (_, i) => {
    const wave = (f) => Math.sin(i * f);
    const burst = (Math.floor(i / 19) % 3) * 6;
    return [30 + burst + 8 * wave(.09) + 5 * wave(.61) + 3 * wave(1.83),
      8 + burst / 4 + 3 * wave(.12) + 2 * wave(.59)];
  });
  history[history.length - 1] = [download, upload];
  const short = $("period").value === "15";
  const series = short ? history.slice(-46) : history;
  const scrub = $("scrub");
  scrub.max = series.length - 1;
  scrub.value = scrub.max;
  function inspect() {
    const i = Number(scrub.value);
    const minutes = Math.round((series.length - 1 - i) / 3);
    $("down").textContent = num(series[i][0]);
    $("up").textContent = num(series[i][1]);
    $("sample-time").textContent = i === series.length-1 ? "Сейчас" : minutes ? minutes + " мин назад" : "Менее минуты назад";
    scrub.setAttribute("aria-valuetext", $("sample-time").textContent + ", загрузка " + num(series[i][0]) + ", отдача " + num(series[i][1]) + " МБ/с");
    $("graph-cursor").setAttribute("x1", 580*i/(series.length-1));
    $("graph-cursor").setAttribute("x2", 580*i/(series.length-1));
  }
  scrub.oninput = inspect;
  function point(event) {
    const rect = $("graph").getBoundingClientRect();
    scrub.value = Math.round(Math.min(1, Math.max(0, (event.clientX-rect.left)/rect.width))*(series.length-1));
    inspect();
  }
  $("graph").onpointermove = point;
  $("graph").onpointerdown = point;
  const points = (channel) => series.map((v,i) => `${(580 * i / (series.length - 1)).toFixed(2)},${(104 - 104 * v[channel] / 80).toFixed(2)}`).join(" ");
  const grid = [0, 26, 52, 78, 104].map(y =>
    `<line x1="0" x2="580" y1="${y}" y2="${y}" stroke="#384036" stroke-dasharray="3 5"/>`).join("");
  $("graph").innerHTML = `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#b6ea77" stop-opacity=".26"/><stop offset="1" stop-color="#b6ea77" stop-opacity=".015"/></linearGradient></defs>
    ${grid}<polygon points="0,104 ${points(0)} 580,104" fill="url(#fill)"/>
    ${["#c4f88a", "#7ac5ae"].map((c,i) => `<polyline points="${points(i)}" fill="none" vector-effect="non-scaling-stroke" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>`).join("")}<line id="graph-cursor" y1="0" y2="104" stroke="#c4f88a" stroke-dasharray="3 3"/>`;
  inspect();
  $("ticks").innerHTML = (short ? ["−15 мин", "−10 мин", "−5 мин", "Сейчас"] :
    ["−60 мин", "−45 мин", "−30 мин", "−15 мин", "Сейчас"]).map(t => "<span>" + t + "</span>").join("");
}
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  $("backdrop").hidden = !open;
  $("menu").setAttribute("aria-expanded", String(open));
  document.querySelector("main").inert = open;
  $("sidebar").inert = matchMedia("(max-width:940px)").matches && !open;
}
function navigate(next, host = "") {
  page = next;
  const [crumb, title, subtitle] = pages[next];
  $("crumb").textContent = crumb;
  $("title").textContent = title;
  $("subtitle").textContent = subtitle;
  document.title = title + " — Склад";
  $("desk").hidden = next !== "overview";
  $("overview").hidden = next !== "overview";
  $("transfers").hidden = !["overview", "torrents"].includes(next);
  $("secondary").hidden = !$("transfers").hidden;
  $("host").value = host;
  $("query").value = "";
  filter = "";
  setMenu(false);
  renderNavigation();
  renderRows();
  renderWorkbench();
  window.scrollTo(0,0);
}
function renderNavigation() {
  const host = $("host").value;
  document.querySelectorAll("nav button").forEach(b => {
    const active = page === "torrents" && host ? b.dataset.host === host : b.dataset.page === page;
    b.classList.toggle("active",active);
    if (active) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current");
  });
}
function showDialog(title, html) {
  if (!$("dialog").open) returnFocus = document.activeElement;
  $("dialog-title").textContent = title;
  $("dialog").setAttribute("aria-labelledby","dialog-title");
  $("dialog-content").innerHTML = html;
  if (!$("dialog").open) $("dialog").showModal();
}
function detail(id) {
  const item = torrents.find(t => t.id === id);
  const values = [["Хост", item.host], ["Носитель", disk(diskForTorrent(item)).name], ["Статус", pill(item.state)], ["Тип", kinds[item.kind][0]], ["Размер", item.size], ["Прогресс", item.percent + "%"]];
  showDialog(item.name, `<dl>${values.map(([k,v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><button class="primary" id="toggle-state">${icon(item.state === "pause" ? "Play" : "Pause")}${item.state === "pause" ? "Продолжить" : "Приостановить"}</button>`);
  if (item.percent === 100) {
    const file = catalog.find(f => f.torrent === id);
    if (file) {
      $("dialog-content").insertAdjacentHTML("beforeend", '<button class="secondary-action" id="move-current">Перенести раздачу</button>');
      $("move-current").onclick = () => { $("dialog").close(); navigate("move"); selectSource(file.id); };
    }
  }
  $("toggle-state").onclick = () => {
    item.state = item.state === "pause" ? (item.percent === 100 ? "seed" : "wait") : "pause";
    rebalance();
    renderChart();
    renderRows();
    if (page === "scheduler") renderScheduler();
    detail(id);
    $("toggle-state").focus();
  };
}
function notify(message) {
  clearTimeout(noticeTimer);
  $("notice").textContent = message;
  noticeTimer = setTimeout(() => $("notice").textContent = "", 3500);
}
function addTorrent() {
  showDialog("Добавить торрент", `<form id="add-form">
    <label>Magnet-ссылка<input id="magnet" required placeholder="magnet:?xt=urn:btih:…" autofocus></label>
    <label>Хост<select id="target"><option>Mac mini</option><option>Windows PC</option></select></label>
    <label>Сохранить на носитель<select id="torrent-disk"></select></label>
    <p class="capacity-label">Раздача появится в демосписке до перезагрузки страницы.</p>
    <button type="submit" class="primary">${icon("Plus")}Добавить</button></form>`);
  $("target").value = $("host").value || "Mac mini";
  function populateTargets() {
    const host=$("target").value;
    const options=disks.filter(d=>d.host===host && !d.offline && d.kind!=="Оптика" && d.id!=="pool");
    $("torrent-disk").replaceChildren(...options.map(d=>new Option(d.name+" · "+sizeText(d.total-d.used)+" свободно",d.id)));
  }
  $("target").onchange=populateTargets;
  populateTargets();
  $("magnet").oninput = () => $("magnet").setCustomValidity("");
  $("add-form").onsubmit = (event) => {
    event.preventDefault();
    const link = $("magnet").value.trim();
    const params = new URLSearchParams(link.slice(link.indexOf("?") + 1));
    const hash = params.getAll("xt").find(x => /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.test(x));
    if (!/^magnet:\?/i.test(link) || !hash) {
      $("magnet").setCustomValidity("Нужна magnet-ссылка с хешем BitTorrent (btih).");
      $("magnet").reportValidity(); return;
    }
    const host = $("target").value;
    torrents.unshift({ id: torrents.length, name: params.get("dn") || hash.slice(9,21) + "…",
      kind: "archive", size: "Размер неизвестен", host, disk: $("torrent-disk").value, state: "down", percent: 0, down: 0, up: 0 });
    $("dialog").close();
    rebalance();
    renderChart();
    navigate("torrents", host);
    notify("Раздача добавлена на " + host);
  };
}

document.querySelectorAll("[data-icon]").forEach(el => { el.innerHTML = icon(el.dataset.icon); });
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.page) navigate(b.dataset.page);
  if (b.dataset.host) navigate("torrents", b.dataset.host);
  if (b.hasAttribute("data-filter")) {
    filter = b.dataset.filter;
    renderRows();
    document.querySelector(".tabs [aria-pressed=true]").focus();
  }
  if (b.hasAttribute("data-detail")) detail(Number(b.dataset.detail));
});
$("query").oninput = renderRows;
$("host").onchange = () => { renderRows(); renderNavigation(); };
$("reset").onclick = () => { navigate(page); $("query").focus(); };
$("period").onchange = renderChart;
$("add").onclick = addTorrent;
$("close").onclick = () => $("dialog").close();
$("dialog").onclick = (e) => { if (e.target === $("dialog")) $("dialog").close(); };
$("dialog").onclose = () => {
  if (returnFocus?.isConnected) returnFocus.focus();
  else if (returnFocus?.dataset.detail) (document.querySelector(`[data-detail="${returnFocus.dataset.detail}"]`) || $("query")).focus();
};
$("menu").onclick = () => { setMenu(true); document.querySelector("nav button").focus(); };
$("backdrop").onclick = () => { setMenu(false); $("menu").focus(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("menu-open")) { setMenu(false); $("menu").focus(); }
});
matchMedia("(max-width:940px)").addEventListener("change", () => setMenu(false));
