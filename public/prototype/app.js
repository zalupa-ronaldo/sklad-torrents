"use strict";
const $ = (id) => document.getElementById(id);
function blankUi(data, page = "overview") {
  return {
    page,
    menu: false,
    modal: null,
    notice: "",
    query: "",
    family: "",
    connection: "all",
    limit: 6,
    fileQuery: "",
    disk: "",
    host: "",
    status: "",
    torrentQuery: "",
    period: "60",
    sample: null,
    platform: "Все",
    category: Object.keys(data.rules || {})[0] || "",
    form: {},
  };
}
function createState(scenario, page = "overview") {
  const data = DemoData.snapshot(scenario);
  return {
    ...data,
    demo: true,
    scenario,
    scenarioOptions: DemoData.scenarios,
    ui: blankUi(data, page),
  };
}
const liveMode = !PanelAdapter.demoEnabled(location.search, globalThis.SKLAD_DEV === true);
let state = liveMode ? { ...PanelAdapter.loadingSnapshot(), ui: blankUi({}) } : createState("normal");

// Update only changed nodes. Ticks and filter changes must not replace a focused input,
// dismiss a native select, reset a file picker or move the caret.
const rendered = new WeakMap();
function patchNode(node, next) {
  if (node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) {
    node.replaceWith(next.cloneNode(true));
    return;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.data !== next.data) node.data = next.data;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const attr of [...node.attributes]) if (!next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
  for (const attr of next.attributes)
    if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  patchChildren(node, next);
  if (node instanceof HTMLInputElement && node.type !== "file" && node.value !== next.value) node.value = next.value;
  if (node instanceof HTMLSelectElement && node.value !== next.value) node.value = next.value;
}
function patchChildren(node, next) {
  for (let i = 0; i < next.childNodes.length; i++) {
    const child = next.childNodes[i];
    if (i >= node.childNodes.length) node.append(child.cloneNode(true));
    else patchNode(node.childNodes[i], child);
  }
  while (node.childNodes.length > next.childNodes.length) node.lastChild.remove();
}
function region(id, html) {
  const node = $(id);
  if (rendered.get(node) === html) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  patchChildren(node, template.content);
  rendered.set(node, html);
}
function render(s) {
  region("sidebar", sidebar(s));
  region("topbar", topbar(s));
  region("page-head", heading(s));
  region(
    "alerts",
    (s.error ? `<p class="host-alert">${icon("Network")}${esc(s.error)}</p>` : "") +
      s.hosts
        .filter((h) => !h.online)
        .map(
          (h) =>
            `<p class="host-alert">${icon("Network")}Нет связи с ${esc(h.name)}.${h.error ? " " + esc(h.error) : " Доступен последний снимок файлов."}</p>`,
        )
        .join(""),
  );
  region("screen", screen(s));
  region("notice", esc(s.ui.notice));
  const dialog = $("dialog");
  if (s.ui.modal) {
    region("dialog", modalView(s));
    if (!dialog.open) {
      dialog.showModal();
      if (s.ui.modal.kind === "add") $("magnet")?.focus();
    }
  } else if (dialog.open) dialog.close();
  document.title = pages[s.ui.page][0] + " — Склад";
  document.body.classList.toggle("menu-open", s.ui.menu);
  $("backdrop").hidden = !s.ui.menu;
  document.querySelector("main").inert = s.ui.menu;
  $("sidebar").inert = !s.ui.menu && matchMedia("(max-width:940px)").matches;
}

let toastTimer;
function message(text) {
  clearTimeout(toastTimer);
  state.ui.notice = text;
  toastTimer = setTimeout(() => {
    state.ui.notice = "";
    render(state);
  }, 3200);
}
function resetForm() {
  if (state.ui.form.artURL) URL.revokeObjectURL(state.ui.form.artURL);
  state.ui.form = {};
}
function navigate(page) {
  resetForm();
  Object.assign(state.ui, { page, menu: false, modal: null });
  window.scrollTo(0, 0);
}
function openSearch() {
  Object.assign(state.ui, { fileQuery: "", disk: "" });
  navigate("drives");
}
function placement(rule, size, host) {
  const candidates = state.disks.filter(
    (d) =>
      available(state, d) &&
      (!host || d.host === host) &&
      (rule.target === "group" ? d.kind === "hdd" : d.id === rule.target) &&
      d.freeBytes >= size,
  );
  return candidates.sort((a, b) => b.freeBytes - a.freeBytes)[0];
}
function writeCopy(file, disk, dir, changes = {}) {
  const copy = { ...file, ...changes, id: crypto.randomUUID(), diskId: disk.id, dir };
  delete copy.torrentId;
  const allocated = copy.allocatedBytes ?? copy.sizeBytes;
  if (disk.freeBytes < allocated) throw new Error("Недостаточно свободного места на " + disk.label + ".");
  state.files.push(copy);
  disk.freeBytes -= allocated;
  return copy;
}
function enqueue(kind, title, host, totalBytes, operation) {
  const duplicate = state.tasks.some(
    (j) =>
      ["running", "paused"].includes(j.state) &&
      (JSON.stringify(j.operation) === JSON.stringify(operation) ||
        (j.operation?.fileId && j.operation.fileId === operation.fileId)),
  );
  if (duplicate) {
    message("Для этого файла уже есть активное задание.");
    return false;
  }
  const rate = Math.max(1, Math.ceil(totalBytes / 18));
  state.tasks.unshift({
    id: crypto.randomUUID(),
    kind,
    title,
    host,
    totalBytes,
    operation,
    bytesPerSec: rate,
    etaSec: 18,
    state: "running",
    progress: 0,
    error: null,
  });
  return true;
}
function onArrival(f) {
  if (!state.automation || !state.previewFresh) return;
  const d = diskOf(state, f);
  if (!available(state, d)) return;
  if (
    f.platform === "Windows" &&
    d.host === "pc" &&
    d.fs === "NTFS" &&
    f.expectedSaving >= 0.1 &&
    !f.allocatedBytes &&
    state.rules["Игры"].after === "Сжатие NTFS"
  ) {
    enqueue("copy", "Подготовка игры · " + f.name, d.host, f.sizeBytes, { type: "compress", fileId: f.id });
  }
  if (f.type !== "Видео" || f.optimized || state.rules["Фильмы"].after !== "HandBrake") return;
  const content = "av1:" + f.contentId;
  if (
    state.files.some((c) => c.contentId === content) ||
    state.tasks.some((j) => ["running", "paused"].includes(j.state) && j.operation?.content === content)
  )
    return;
  const size = Math.round(f.sizeBytes * 0.67),
    rule = state.rules["Фильмы"],
    dest = placement(rule, size);
  if (dest)
    enqueue("copy", "Подготовка видео · " + f.name, "mac", f.sizeBytes, {
      type: "encode",
      fileId: f.id,
      content,
      size,
      target: dest.id,
      dir: rule.folder + "/",
    });
}
function completeTask(task) {
  const op = task.operation;
  if (!op) return;
  const f = byId(state.files, op.fileId),
    target = byId(state.disks, op.target);
  if (
    !byId(state.hosts, task.host)?.online ||
    (f && !available(state, diskOf(state, f))) ||
    (target && !available(state, target))
  )
    throw new Error("Нет связи с носителем. Подключите его и повторите задание.");
  switch (op.type) {
    case "index":
      target.lastScan = new Date().toISOString();
      break;
    case "sha256":
      Object.assign(state.manifests, op.hashes);
      if (op.other) {
        const other = byId(state.files, op.other);
        state.comparisons.push(
          f.name +
            " ↔ " +
            other.name +
            " · " +
            (op.hashes[f.id] === op.hashes[other.id] ? "Копии совпали" : "Контрольные суммы различаются"),
        );
      }
      break;
    case "copy":
    case "receive":
    case "game": {
      const copy = writeCopy(f, target, op.dir ?? f.dir, op.type === "game" ? { original: f.id } : {});
      onArrival(copy);
      break;
    }
    case "move": {
      const allocated = f.allocatedBytes ?? f.sizeBytes;
      if (target.id !== f.diskId && target.freeBytes < allocated) throw new Error("Недостаточно свободного места.");
      diskOf(state, f).freeBytes += allocated;
      target.freeBytes -= allocated;
      f.diskId = target.id;
      f.dir = op.dir ?? f.dir;
      const torrent = byId(state.torrents, f.torrentId);
      if (torrent) torrent.diskId = target.id;
      onArrival(f);
      break;
    }
    case "compress":
      f.allocatedBytes = Math.round(f.sizeBytes * (1 - f.expectedSaving));
      diskOf(state, f).freeBytes += f.sizeBytes - f.allocatedBytes;
      break;
    case "encode":
      writeCopy(f, target, op.dir, {
        contentId: op.content,
        optimized: true,
        name: f.name.replace(/\.[^.]+$/, "") + ".sklad-av1.mkv",
        sizeBytes: op.size,
        allocatedBytes: op.size,
      });
      break;
    case "burn": {
      const d = {
        id: crypto.randomUUID(),
        label: "Запись " + op.medium + " · " + f.name,
        kind: "optical",
        host: task.host,
        sizeBytes: mediaCapacity[op.medium],
        freeBytes: mediaCapacity[op.medium],
        online: false,
        lastSeen: new Date().toISOString(),
        mount: null,
        fs: "UDF",
        location: "Полка · новая запись",
      };
      writeCopy(f, d, f.dir);
      state.disks.push(d);
      break;
    }
    case "image":
      writeCopy(f, target, "Images/", { contentId: task.id, name: op.name, type: "Образ", platform: null });
      break;
    case "send":
      break;
  }
}
function advanceTasks(seconds) {
  let changed = false;
  // Snapshot the list: completing a copy can enqueue another job.
  for (const j of [...state.tasks]) {
    if (j.state !== "running") continue;
    changed = true;
    j.progress = Math.min(100, j.progress + ((seconds * j.bytesPerSec) / Math.max(j.totalBytes, 1)) * 100);
    j.etaSec = Math.max(0, Math.ceil((((100 - j.progress) / 100) * j.totalBytes) / j.bytesPerSec));
    if (j.progress < 100) continue;
    j.state = "done";
    j.bytesPerSec = 0;
    j.etaSec = 0;
    try {
      completeTask(j);
    } catch (e) {
      j.state = "error";
      j.error = e.message;
      j.etaSec = null;
    }
  }
  if (changed) render(state);
}
async function liveJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" && body.error ? body.error : "Панель отклонила запрос.");
  return body;
}
let liveFlight = null;
async function refreshLive() {
  if (state.demo) return;
  if (liveFlight) return liveFlight;
  liveFlight = PanelAdapter.loadPanel({ fetchImpl: fetch, timeoutMs: 8000 })
    .then((snapshot) => {
      const keepFiles = Boolean(state.ui.fileQuery || state.ui.disk);
      state = { ...snapshot, ui: state.ui, files: keepFiles ? state.files : snapshot.files, demo: false, catalogError: state.catalogError };
      render(state);
    })
    .catch((error) => {
      state.loading = false;
      state.error = error instanceof PanelAdapter.PanelError ? error.message : "Панель не ответила.";
      render(state);
    })
    .finally(() => {
      liveFlight = null;
    });
  return liveFlight;
}
let searchTimer;
function scheduleCatalog() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refreshCatalog(), 300);
}
async function refreshCatalog() {
  if (state.demo) return;
  try {
    state.files = await PanelAdapter.loadCatalog(fetch, { q: state.ui.fileQuery, diskId: state.ui.disk, timeoutMs: 8000 });
    state.catalogError = null;
  } catch (error) {
    state.catalogError = error instanceof PanelAdapter.PanelError ? error.message : "Каталог не ответил.";
  }
  render(state);
}
async function liveTask(name, id) {
  const j = byId(state.tasks, id);
  if (!j) return;
  if (j.source === "copy") {
    if (name === "retry") {
      message("Повтор копирования эта кнопка не отправляет.");
      return;
    }
    const action = name === "pause" && j.state === "paused" ? "resume" : name;
    if (!j.progressId) {
      message("У копирования нет идентификатора прогресса.");
      return;
    }
    await liveJson(`/api/progress/${encodeURIComponent(j.progressId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action }),
    });
    await refreshLive();
    return;
  }
  if (j.source === "queue") {
    const action = name === "pause" && j.state === "paused" ? "resume" : name;
    await liveJson(`/api/jobs/${encodeURIComponent(j.id)}/${encodeURIComponent(action)}`, { method: "POST", headers: { accept: "application/json" } });
    await refreshLive();
    return;
  }
  message("Эта задача не управляется из живой панели.");
}
async function liveToggle(id) {
  const t = byId(state.torrents, id);
  if (!t?.hostId) {
    message("У раздачи нет хоста qBittorrent.");
    return;
  }
  const action = t.state === "pause" ? "resume" : "pause";
  await liveJson(`/api/torrents/${encodeURIComponent(t.hostId)}/${encodeURIComponent(t.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action }),
  });
  await refreshLive();
}
async function liveCopy() {
  const file = byId(state.files, state.ui.form.source) || state.files.find((item) => item.path && item.diskId);
  const dest = byId(state.destinations || [], state.ui.form.dest);
  if (!file?.path || !file.diskId || !dest?.id) {
    message("Нужны файл из каталога и назначение.");
    return;
  }
  await liveJson("/api/files/copy", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ diskId: file.diskId, path: file.path, destinationId: dest.id }),
  });
  message("Копирование поставлено в очередь. SHA-256 считает панель.");
  navigate("jobs");
  await refreshLive();
}
async function taskAction(name, id) {
  if (!state.demo) return liveTask(name, id);
  const j = byId(state.tasks, id);
  if (!j) return;
  if (name === "cancel") {
    state.tasks = state.tasks.filter((t) => t !== j);
    message("Задание отменено.");
    return;
  }
  if (name === "pause" && j.state === "running") {
    j.state = "paused";
    j.resumeRate = j.bytesPerSec;
    j.bytesPerSec = 0;
    j.etaSec = null;
    return;
  }
  if ((name === "pause" && j.state === "paused") || (name === "retry" && j.state === "error")) {
    if (name === "retry") j.progress = 0;
    j.state = "running";
    j.error = null;
    j.bytesPerSec = j.resumeRate || Math.max(1, Math.ceil(j.totalBytes / 30));
    j.etaSec = Math.ceil(((1 - j.progress / 100) * j.totalBytes) / j.bytesPerSec);
  }
}
async function runOperation() {
  const s = state,
    u = s.ui,
    page = u.page,
    m = operationModel(s);
  if (m.reason || !m.file) return;
  const f = m.file;
  let kind = "copy",
    host = m.src.host,
    title,
    op;
  if (page === "move") {
    title = m.mode + " · " + f.name;
    op = { type: m.mode === "Копирование" ? "copy" : "move", fileId: f.id, target: m.target.id };
  } else if (page === "integrity") {
    kind = "sha256";
    title = "SHA-256 · " + f.name;
    const entries = await Promise.all(
      [f, m.other].filter(Boolean).map(async (c) => {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sklad-demo/" + c.contentId));
        return [c.id, [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")];
      }),
    );
    if (state !== s || u.page !== page) return;
    op = { type: "sha256", fileId: f.id, other: m.other?.id, hashes: Object.fromEntries(entries) };
  } else if (page === "localsend") {
    title = "LocalSend · " + (m.receive ? "Приём" : "Отправка") + " · " + f.name;
    op = { type: m.receive ? "receive" : "send", fileId: f.id, peer: m.peer.id };
    if (m.receive) {
      op.target = m.inbox.id;
      op.dir = "Inbox/";
      host = m.inbox.host;
    }
  } else {
    title = m.opt + " · " + m.medium;
    host = byId(s.disks, s.imageDisk).host;
    op = { type: m.opt === "Записать и проверить" ? "burn" : "image", medium: m.medium, fileId: f.id };
    if (op.type === "image") {
      op.target = s.imageDisk;
      op.name = (m.art ? u.form.artName || "Склад" : f.name) + "." + (m.art && m.medium === "CD-R" ? "wav" : "iso");
    }
  }
  if (enqueue(kind, title, host, f.sizeBytes, op)) navigate("jobs");
}
function rebalance() {
  for (const d of state.disks) {
    const ts = state.torrents.filter((t) => t.diskId === d.id),
      running = ts.filter((t) => t.state === "down");
    running.slice(available(state, d) ? 1 : 0).forEach((t) => {
      t.state = "wait";
    });
    if (!running.length && available(state, d)) {
      const t = ts.filter((t) => t.state === "wait").sort((a, b) => a.rank - b.rank)[0];
      if (t) {
        t.state = "down";
        t.down ||= state.demoTransferRate;
      }
    }
  }
}
function finishTorrent(id) {
  const t = byId(state.torrents, id),
    d = diskOf(state, t);
  if (!available(state, d) || t.state !== "down") return;
  t.progress = 100;
  t.state = "seed";
  t.down = 0;
  if (!state.files.some((f) => f.torrentId === id)) {
    const f = {
      id: crypto.randomUUID(),
      name: t.name,
      type: fileTypes[t.kind][0],
      sizeBytes: t.sizeBytes ?? 0,
      diskId: d.id,
      dir: "Downloads/",
      torrentId: id,
      contentId: "torrent:" + id,
    };
    state.files.push(f);
    d.freeBytes = Math.max(0, d.freeBytes - f.sizeBytes);
    const rule = state.rules[{ image: "Софт", video: "Фильмы", audio: "Музыка" }[t.kind] || "Прочее"];
    const target = state.automation ? placement(rule, f.sizeBytes, d.host) : null;
    if (target)
      enqueue("copy", "Раскладка · " + f.name, d.host, f.sizeBytes, {
        type: "move",
        fileId: f.id,
        target: target.id,
        dir: rule.folder + "/",
      });
    else onArrival(f);
  }
  rebalance();
}
function gameAction(id) {
  const f = byId(state.files, id),
    copy = state.files.find((c) => c.original === id),
    pool = byId(state.disks, state.gamePool);
  if (copy || f.platform === "macOS") {
    state.ui.modal = { kind: copy ? "launch" : "file", id: copy?.id || id };
    return;
  }
  if (!available(state, pool) || pool.freeBytes < f.sizeBytes) {
    message("Игровой SSD недоступен или заполнен.");
    return;
  }
  if (
    enqueue("copy", "Подготовить игру · " + f.name, pool.host, f.sizeBytes, {
      type: "game",
      fileId: id,
      target: pool.id,
      dir: "Games/",
    })
  )
    navigate("jobs");
}

async function act(name, value) {
  const u = state.ui;
  switch (name) {
    case "page":
      navigate(value);
      break;
    case "menu":
      u.menu = true;
      break;
    case "closeMenu":
      u.menu = false;
      break;
    case "host":
      navigate("torrents");
      u.host = value;
      u.status = "";
      u.torrentQuery = "";
      break;
    case "find":
      openSearch();
      break;
    case "quickCopy":
      navigate("move");
      u.form.mode = "Копирование";
      break;
    case "family":
      u.family = u.family === value ? "" : value;
      u.limit = 6;
      break;
    case "clearShelf":
      Object.assign(u, { family: "", query: "", connection: "all", limit: 6 });
      break;
    case "more":
      u.limit += 12;
      break;
    case "disk":
      navigate("drives");
      u.disk = value;
      u.fileQuery = "";
      break;
    case "file":
    case "torrent":
      u.modal = { kind: name, id: value };
      break;
    case "close":
      u.modal = null;
      break;
    case "fileOp": {
      const id = u.modal.id;
      navigate(value);
      u.form.source = id;
      break;
    }
    case "add":
      resetForm();
      u.form.addHost = u.host;
      u.modal = { kind: "add" };
      break;
    case "status":
      u.status = value;
      break;
    case "resetTorrents":
      u.status = "";
      u.host = "";
      u.torrentQuery = "";
      break;
    case "toggleTorrent": {
      if (!state.demo) {
        await liveToggle(value);
        break;
      }
      const t = byId(state.torrents, value);
      t.state = t.state === "pause" ? (t.progress === 100 ? "seed" : "wait") : "pause";
      rebalance();
      break;
    }
    case "moveTorrent":
      navigate("move");
      u.form.source = state.files.find((f) => f.torrentId === value).id;
      break;
    case "platform":
      u.platform = value;
      break;
    case "game":
      gameAction(value);
      break;
    case "reindex": {
      const d = byId(state.disks, value);
      if (enqueue("index", "Обновить индекс · " + d.label, d.host, d.sizeBytes, { type: "index", target: d.id }))
        navigate("jobs");
      break;
    }
    case "run":
      if (!state.demo) {
        message("Эта операция в живой панели не отправляется.");
        break;
      }
      await runOperation();
      break;
    case "liveCopy":
      await liveCopy();
      break;
    case "dest":
      u.form.dest = value;
      break;
    case "pause":
    case "cancel":
    case "retry":
      taskAction(name, value);
      break;
    case "next":
      byId(state.torrents, value).rank = Math.min(...state.torrents.map((t) => t.rank)) - 1;
      break;
    case "finish":
      if (!state.demo) {
        message("Завершение раздачи делает qBittorrent.");
        break;
      }
      finishTorrent(value);
      break;
    case "dry":
      state.previewFresh = true;
      break;
    case "auto":
      if (state.previewFresh) state.automation = !state.automation;
      break;
  }
}
async function dispatch(name, value) {
  const wasPage = state.ui.page;
  try {
    await act(name, value);
  } catch (e) {
    message(e.message);
  }
  render(state);
  if (name === "find") $("catalog-q")?.focus();
  else if (name === "menu") $("sidebar").querySelector("button")?.focus();
  else if (name === "closeMenu") $("menu").focus();
  else if (wasPage !== state.ui.page) $("title").focus();
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-action]");
  if (b) void dispatch(b.dataset.action, b.dataset.value);
  else if (e.target === $("backdrop")) void dispatch("closeMenu");
  else if (e.target === $("dialog")) void dispatch("close");
});
$("dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  void dispatch("close");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.ui.menu) void dispatch("closeMenu");
});
matchMedia("(max-width:940px)").addEventListener("change", () => {
  state.ui.menu = false;
  render(state);
});

const textFields = { "shelf-query": "query", "catalog-q": "fileQuery", query: "torrentQuery" };
function updateControl(el) {
  const u = state.ui,
    id = el.id,
    v = el.value;
  if (id === "scenario") {
    resetForm();
    clearTimeout(toastTimer);
    state = createState(v, u.page);
  } else if (id === "savePath") u.form.savePath = v;
  else if (id in textFields) {
    u[textFields[id]] = v;
    if (id === "shelf-query") u.limit = 6;
  } else if (id === "shelf-filter") {
    u.connection = v;
    u.limit = 6;
  } else if (id === "disk-filter") u.disk = v;
  else if (id === "host") u.host = v;
  else if (id === "scrub") u.sample = Number(v);
  else if (id === "period") {
    u.period = v;
    u.sample = null;
  } else if (id === "category") u.category = v;
  else if (["folder", "rule-target", "rule-index", "after"].includes(id)) {
    const rule = state.rules[u.category];
    rule[{ "rule-target": "target", "rule-index": "index" }[id] || id] = v;
    if (id === "rule-target" && v !== "group" && byId(state.disks, v).fs !== "NTFS") {
      if (rule.index === "NTFS MFT") rule.index = "Обход папок";
      if (rule.after === "Сжатие NTFS") rule.after = "Без обработки";
    }
    state.previewFresh = false;
    state.automation = false;
  } else if (id === "art-file") {
    if (u.form.artURL) URL.revokeObjectURL(u.form.artURL);
    const image = el.files[0];
    u.form.artURL = image ? URL.createObjectURL(image) : "";
    u.form.artName = image?.name;
  } else if (id) {
    if (id === "source") {
      delete u.form.mode;
      delete u.form.dest;
      delete u.form.compare;
    }
    if (id === "addHost") delete u.form.addDisk;
    if (id === "magnet") el.setCustomValidity("");
    u.form[id] = v;
  }
  render(state);
  if (!state.demo && (id === "catalog-q" || id === "disk-filter")) scheduleCatalog();
}
document.addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== "file") updateControl(e.target);
});
document.addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target.type === "file") updateControl(e.target);
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-form") return;
  e.preventDefault();
  if (!state.demo) {
    const magnet = $("magnet");
    const link = magnet.value.trim();
    const hostId = $("addHost")?.value;
    const savePath = $("savePath")?.value.trim();
    if (!/^magnet:\?/i.test(link) || !hostId || !savePath) {
      magnet.setCustomValidity("Нужны magnet-ссылка, хост и каталог.");
      magnet.reportValidity();
      return;
    }
    void liveJson("/api/torrents", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ hostId, urls: link, savePath }),
    })
      .then(async () => {
        state.ui.modal = null;
        message("Раздача добавлена.");
        await refreshLive();
      })
      .catch((error) => {
        message(error.message);
        render(state);
      });
    return;
  }
  const magnet = $("magnet"),
    link = magnet.value.trim(),
    params = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  const hash = params.getAll("xt").find((x) => /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.test(x));
  if (!/^magnet:\?/i.test(link) || !hash) {
    magnet.setCustomValidity("Укажите magnet-ссылку с хешем BitTorrent (btih).");
    magnet.reportValidity();
    return;
  }
  const d = byId(state.disks, $("addDisk").value);
  if (!available(state, d)) return;
  state.torrents.unshift({
    id: crypto.randomUUID(),
    name: params.get("dn") || hash.slice(9, 21) + "…",
    kind: "archive",
    diskId: d.id,
    sizeBytes: null,
    progress: 0,
    state: "wait",
    down: 0,
    up: 0,
    rank: state.torrents.length,
  });
  Object.assign(state.ui, { modal: null, host: d.host, torrentQuery: "", status: "" });
  rebalance();
  message("Раздача добавлена.");
  render(state);
});
document.addEventListener("dragstart", (e) => {
  if (e.target.id === "grab-file") {
    const model = operationModel(state);
    if (model.file) e.dataTransfer.setData("text/plain", model.file.id);
  }
});
document.addEventListener("dragover", (e) => {
  if (e.target.closest('[data-action="dest"]')) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const dest = e.target.closest('[data-action="dest"]');
  if (dest) {
    e.preventDefault();
    const model = operationModel(state);
    if (model.file && e.dataTransfer.getData("text/plain") === model.file.id) void dispatch("dest", dest.dataset.value);
  }
});
function inspectGraph(e) {
  const graph = e.target.closest("#graph");
  if (!graph) return;
  const { left, width } = graph.getBoundingClientRect();
  const sample = Math.round(Math.min(1, Math.max(0, (e.clientX - left) / width)) * Number($("scrub").max));
  if (sample !== state.ui.sample) {
    state.ui.sample = sample;
    render(state);
  }
}
document.addEventListener("pointermove", inspectGraph);
document.addEventListener("pointerdown", inspectGraph);
render(state);
if (state.demo) setInterval(() => advanceTasks(1), 1000);
else {
  void refreshLive();
  setInterval(() => void refreshLive(), 4000);
}
