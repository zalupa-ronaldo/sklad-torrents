"use strict";
const $ = (id) => document.getElementById(id);
function createState(scenario, page = "overview") {
  const data = DemoData.snapshot(scenario);
  return {
    ...data,
    scenario,
    scenarioOptions: DemoData.scenarios,
    ui: {
      page,
      menu: false,
      navMore: false,
      taskId: data.tasks[0]?.id,
      pending: null,
      modal: null,
      notice: "",
      query: "",
      family: "",
      connection: "all",
      limit: 6,
      fileQuery: "",
      fileId: null,
      disk: "",
      host: "",
      status: "",
      torrentQuery: "",
      period: "60",
      sample: null,
      platform: "Все",
      taskKind: "",
      category: Object.keys(data.rules)[0],
      form: {},
    },
  };
}
const demoOn = globalThis.PanelAdapter && PanelAdapter.demoEnabled(location.search, globalThis.SKLAD_DEV === true);
let state = demoOn ? createState("normal") : LiveWire.placeholder();
state.demo = Boolean(demoOn);

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
    s.hosts
      .filter((h) => !h.online)
      .map(
        (h) => `<p class="host-alert">${icon("Network")}Нет связи с ${esc(h.name)}. Доступен последний снимок файлов.</p>`,
      )
      .join(""),
  );
  const pageFault = s.faults?.[s.ui.page];
  const feedback = pageFault ? `<p class="action-fault" role="alert">${icon("Activity")}${esc(pageFault)}</p>` : "";
  const busy = s.ui.pending ? '<p class="busy-line" role="status">Выполняется операция…</p>' : "";
  region("action-status", s.ui.modal || s.loading ? "" : feedback + busy);
  region("screen", screen(s));
  region("notice", esc(s.ui.notice));
  const dialog = $("dialog");
  const modalKey = s.ui.modal?.kind;
  const changedDialog = dialog.dataset.view !== modalKey;
  if (s.ui.modal) {
    region("dialog", modalView(s) + (s.ui.modal && s.ui.pending ? busy : "") + (s.ui.modal && pageFault ? feedback : ""));
    if (!dialog.open) {
      dialog.showModal();
      if (s.ui.modal.kind === "add") $("magnet")?.focus();
    }
    dialog.dataset.view = modalKey;
    if (modalKey === "confirm") {
      dialog.setAttribute("aria-describedby", "confirm-description");
      if (changedDialog) $("confirm-cancel")?.focus();
    } else {
      dialog.removeAttribute("aria-describedby");
      if (changedDialog && modalKey.startsWith("inv")) dialog.querySelector("input,select,button")?.focus();
    }
  } else if (dialog.open) {
    dialog.close();
    delete dialog.dataset.view;
  }
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
let requestHeavy = () => {};
function navigate(page) {
  resetForm();
  if (["media", "index", "integrity", "policies", "hosts", "scheduler", "localsend", "optical"].includes(page))
    state.ui.navMore = true;
  if (page === "jobs") state.ui.taskKind = "";
  Object.assign(state.ui, { page, menu: false, modal: null });
  window.scrollTo(0, 0);
  requestHeavy();
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
function canCompressFile(f) {
  return f.sizeBytes > 0 && (f.allocatedBytes ?? f.sizeBytes) >= f.sizeBytes;
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
  const job = state.tasks[0],
    paths = state.toolPaths[host];
  if (operation.type === "encode" && paths?.encoder) recordEvent(job, paths.encoder + " · " + operation.preset);
  if (operation.type === "folderCompress" && paths?.compact) recordEvent(job, paths.compact + " · " + operation.algorithm);
  recordEvent(job, "Задача поставлена в очередь.");
  return true;
}
function onArrival(f) {
  if (!state.schedule.enabled || !state.automation || !state.previewFresh) return;
  const d = diskOf(state, f);
  if (!available(state, d)) return;
  if (
    f.platform === "Windows" &&
    d.host === "pc" &&
    d.fs === "NTFS" &&
    f.expectedSaving >= 0.1 &&
    canCompressFile(f) &&
    state.rules["Игры"]?.after === "Сжатие NTFS"
  ) {
    enqueue("copy", "Подготовка игры · " + f.name, d.host, f.sizeBytes, { type: "compress", fileId: f.id });
  }
  if (f.type !== "Видео" || f.optimized || state.rules["Фильмы"]?.after !== "HandBrake") return;
  const content = "av1:" + f.contentId;
  if (
    state.files.some((c) => c.contentId === content) ||
    state.tasks.some((j) => ["running", "paused"].includes(j.state) && j.operation?.content === content)
  )
    return;
  const profile = state.encodingProfiles[state.toolSettings.preset];
  const size = Math.round(f.sizeBytes * (1 - profile.saveRatio)),
    rule = state.rules["Фильмы"],
    dest = placement(rule, size);
  if (dest)
    enqueue("av1", "AV1 · " + f.name, d.host, f.sizeBytes, {
      type: "encode",
      preset: state.toolSettings.preset,
      fps: profile.fps,
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
  if ((op.fileId && !f) || (op.target && !target) || (op.other && !byId(state.files, op.other)))
    throw Error("Источник или назначение отсутствует в снимке.");
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
    case "place":
    case "copy": {
      if (op.torrentId && (!byId(state.torrents, op.torrentId) || f.torrentId !== op.torrentId))
        throw Error("Раздача изменилась во время переноса.");
      const reason = copyReason(state, f, target, op.dir ?? f.dir);
      if (reason) throw new Error(reason);
      const copy = writeCopy(f, target, op.dir ?? f.dir, { allocatedBytes: f.sizeBytes });
      state.manifests[copy.id] = task.checksum;
      task.copyId = copy.id;
      task.sourcePath = pathOf(state, f);
      if (op.torrentId) {
        const torrent = byId(state.torrents, op.torrentId);
        torrent.diskId = target.id;
        copy.torrentId = torrent.id;
        delete f.torrentId;
      }
      task.verified = true;
      onArrival(copy);
      break;
    }
    case "receive":
    case "game": {
      const copy = writeCopy(f, target, op.dir ?? f.dir, op.type === "game" ? { original: f.id } : {});
      onArrival(copy);
      break;
    }
    case "folderCompress": {
      let saved = 0;
      for (const file of state.files.filter((c) => c.diskId === target.id && c.dir === op.dir && canCompressFile(c))) {
        file.allocatedBytes = Math.round(file.sizeBytes * (1 - state.compressionRatios[op.algorithm]));
        saved += file.sizeBytes - file.allocatedBytes;
      }
      target.freeBytes += saved;
      state.reclaimedBytes += saved;
      task.savedBytes = saved;
      recordEvent(task, "Освобождено " + bytes(saved));
      break;
    }
    case "compress":
      if (!canCompressFile(f)) {
        recordEvent(task, "Файл уже сжат.");
        break;
      }
      f.allocatedBytes = Math.round(f.sizeBytes * (1 - f.expectedSaving));
      diskOf(state, f).freeBytes += f.sizeBytes - f.allocatedBytes;
      state.reclaimedBytes += f.sizeBytes - f.allocatedBytes;
      break;
    case "encode":
      if (state.files.some((c) => c.contentId === op.content)) throw Error("AV1-копия уже существует.");
      writeCopy(f, target, op.dir, {
        contentId: op.content,
        optimized: true,
        tracks: f.tracks?.map((t) => {
          if (t.kind !== "video") return { ...t };
          const profile = state.encodingProfiles[op.preset];
          const details = profile?.height === 720 ? t.details.replace(/1920 × 1080/g, "1280 × 720") : t.details;
          return { ...t, codec: "AV1", details };
        }),
        name: f.name.replace(/\.[^.]+$/, "") + ".sklad-av1.mkv",
        sizeBytes: op.size,
        allocatedBytes: op.size,
      });
      task.savedBytes = f.sizeBytes - op.size;
      break;
    case "burn": {
      if (!state.opticalDrive?.writable || state.opticalDrive.open || state.opticalDrive.medium !== op.medium)
        throw Error("Установите чистый носитель выбранного типа.");
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
      state.opticalDrive.writable = false;
      break;
    }
    case "image": {
      const image = writeCopy(f, target, "Images/", {
        contentId: task.id,
        name: op.name,
        type: "Образ",
        platform: null,
        tracks: [],
      });
      state.opticalImages.push({
        id: image.id,
        fileId: image.id,
        diskId: target.id,
        name: image.name,
        sizeBytes: image.sizeBytes,
      });
      break;
    }
    case "send":
      if (![...state.hosts, ...state.devices].some((p) => p.id === op.peer && p.online))
        throw Error("Устройство больше не в сети.");
      recordEvent(task, "Получатель подтвердил передачу.");
      break;
  }
}
async function fixtureDigest(contentId) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sklad-demo/" + contentId));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const finishing = new WeakSet();
async function finishTask(j, snapshot) {
  if (finishing.has(j)) return;
  finishing.add(j);
  try {
    if (["copy", "place"].includes(j.operation?.type)) {
      const f = byId(snapshot.files, j.operation.fileId);
      const expected = snapshot.manifests[f.id] || snapshot.checksums[f.contentId] || (await fixtureDigest(f.contentId));
      const actual = await fixtureDigest(f.contentId);
      j.sourceChecksum = expected;
      if (actual !== expected) throw new Error("SHA-256 не совпал. Копия не добавлена в каталог.");
      j.checksum = actual;
    }
    if (snapshot !== state || !state.tasks.includes(j) || j.state !== "running") return;
    j.state = "done";
    j.bytesPerSec = 0;
    j.etaSec = 0;
    completeTask(j);
    recordEvent(j, j.verified ? "SHA-256 совпал. Копия зарегистрирована." : "Операция завершена.");
  } catch (error) {
    if (snapshot !== state || !state.tasks.includes(j) || j.state === "paused") return;
    j.state = "error";
    j.bytesPerSec = 0;
    j.etaSec = null;
    j.error = error.message;
    recordEvent(j, error.message);
  } finally {
    finishing.delete(j);
    if (state === snapshot) render(state);
  }
}
function advanceTasks(seconds) {
  const minute = Math.floor(state.schedule.clock / 60000);
  Pipeline.tick(state, seconds);
  let changed = state.ui.page === "scheduler" && minute !== Math.floor(state.schedule.clock / 60000);
  // Snapshot the list: completing a copy can enqueue another job.
  for (const j of [...state.tasks]) {
    if (j.state !== "running") continue;
    changed = true;
    const milestone = Math.floor(j.progress / 25);
    j.progress = Math.min(100, j.progress + ((seconds * j.bytesPerSec) / Math.max(j.totalBytes, 1)) * 100);
    j.etaSec = Math.max(0, Math.ceil((((100 - j.progress) / 100) * j.totalBytes) / j.bytesPerSec));
    if (j.progress < 100 && Math.floor(j.progress / 25) > milestone)
      recordEvent(j, "Выполнено " + Math.floor(j.progress) + "%.");
    if (j.progress < 100) continue;
    void finishTask(j, state);
  }
  if (changed) render(state);
}
function taskAction(name, id) {
  const j = byId(state.tasks, id);
  if (!j) return;
  if (name === "cancel") {
    j.state = "cancelled";
    j.bytesPerSec = 0;
    j.etaSec = null;
    recordEvent(j, "Операция отменена.");
    state.cancelled.push(j);
    state.tasks = state.tasks.filter((t) => t !== j);
    message("Задание отменено.");
    return;
  }
  if (name === "pause" && j.state === "running") {
    recordEvent(j, "Поставлено на паузу.");
    j.state = "paused";
    j.resumeRate = j.bytesPerSec;
    j.bytesPerSec = 0;
    j.etaSec = null;
    return;
  }
  if ((name === "pause" && j.state === "paused") || (name === "retry" && j.state === "error")) {
    if (!taskAvailable(state, j)) {
      message("Для продолжения подключите носитель и его хост.");
      return;
    }
    recordEvent(j, name === "retry" ? "Запущено повторно." : "Выполнение продолжено.");
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
    op = { type: "copy", moveSource: m.mode !== "Копирование", fileId: f.id, target: m.target.id };
  } else if (page === "integrity") {
    kind = "sha256";
    title = "SHA-256 · " + f.name;
    const entries = await Promise.all(
      [f, m.other].filter(Boolean).map(async (c) => {
        return [c.id, await fixtureDigest(c.contentId)];
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
  if (enqueue(kind, title, host, f.sizeBytes, op)) openJob(s.tasks[0].id);
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
    const target = state.schedule.enabled && state.automation ? placement(rule, f.sizeBytes, d.host) : null;
    if (target)
      enqueue("copy", "Раскладка · " + f.name, d.host, f.sizeBytes, {
        type: "place",
        torrentId: t.id,
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
    if (copy) state.ui.modal = { kind: "launch", id: copy.id };
    else {
      navigate("details");
      state.ui.fileId = id;
    }
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

function askConfirm(kind, id, title, description, label) {
  state.ui.modal = { kind: "confirm", action: kind, id, title, description, label };
}
async function act(name, value) {
  if (name.startsWith("inv")) return Inventory.act(name, value);
  if (name.startsWith("pipe")) return Pipeline.act(name, value);
  if (name.startsWith("shop")) return Workshops.act(name, value);
  const u = state.ui;
  switch (name) {
    case "page":
      navigate(value);
      break;
    case "confirmAction": {
      const m = u.modal;
      if (m?.kind !== "confirm") break;
      if (m.action === "pipeDelete") Pipeline.confirmed(m.action, m.id);
      else Inventory.confirmed(m.action, m.id);
      u.modal = null;
      message("Изменения сохранены.");
      break;
    }
    case "navMore":
      u.navMore = !u.navMore;
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
      if (u.page !== "details") navigate("details");
      u.fileId = value;
      delete u.form.copyTarget;
      break;
    case "backToFiles":
      navigate("drives");
      break;
    case "copyDetail": {
      const f = byId(state.files, u.fileId),
        target = byId(state.disks, u.form.copyTarget);
      if (!f || copyReason(state, f, target)) break;
      if (
        enqueue("copy", "Копирование · " + f.name, diskOf(state, f).host, f.sizeBytes, {
          type: "copy",
          fileId: f.id,
          target: target.id,
        })
      ) {
        navigate("jobs");
        u.taskKind = "";
      }
      break;
    }
    case "torrent":
      u.modal = { kind: name, id: value };
      break;
    case "close":
      u.modal = null;
      break;
    case "fileOp": {
      const id = u.fileId;
      navigate(value);
      u.form.source = id;
      break;
    }
    case "addTorrent":
      addTorrent();
      break;
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
      const t = byId(state.torrents, value);
      t.state = t.state === "pause" ? (t.progress === 100 ? "seed" : "wait") : "pause";
      rebalance();
      break;
    }
    case "moveTorrent":
      navigate("move");
      u.form.source = state.files.find((f) => f.torrentId === value).id;
      break;
    case "taskKind":
      u.taskKind = value;
      break;
    case "platform":
      u.platform = value;
      break;
    case "game":
      gameAction(value);
      break;
    case "reindex": {
      const d = byId(state.disks, value);
      if (!available(state, d)) break;
      if (enqueue("index", "Обновить индекс · " + d.label, d.host, d.sizeBytes, { type: "index", target: d.id })) {
        if (u.page !== "devices") navigate("jobs");
        else message("Сканирование началось.");
      }
      break;
    }
    case "run":
      await runOperation();
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
const simulatedRequests = new Set([
  "invSaveHost",
  "invProbe",
  "invCompress",
  "invDownload",
  "invManifest",
  "invMigrate",
  "confirmAction",
  "pipeSchedule",
  "pipeAuto",
  "pipeSettings",
  "pipeSSD",
  "pipeCompress",
  "pipeEncode",
  "shopDiscover",
  "shopTray",
  "shopBlank",
  "shopSendSettings",
  "shopApply",
  "run",
  "reindex",
  "copyDetail",
  "game",
  "toggleTorrent",
  "dry",
  "auto",
  "finish",
  "next",
  "pause",
  "cancel",
  "invHashRun",
  "retry",
  "addTorrent",
]);
async function dispatch(name, value) {
  if (!state.demo && globalThis.LiveWire) {
    const outcome = await LiveWire.handle(name, value, state);
    if (outcome && outcome.stop) {
      if (outcome.message) message(outcome.message);
      if (outcome.refresh) {
        try {
          state = await LiveWire.refresh(state);
        } catch (error) {
          state.loading = false;
          state.error = error instanceof Error ? error.message : "Панель не ответила.";
        }
      }
      render(state);
      return;
    }
  }
  const snapshot = state,
    wasPage = state.ui.page,
    modal = state.ui.modal;
  if (state.ui.pending && simulatedRequests.has(name)) return;
  let pending = null;
  try {
    if (simulatedRequests.has(name)) {
      pending = { name, value };
      state.ui.pending = pending;
      render(state);
      await new Promise((resolve) => setTimeout(resolve, 240));
      if (state !== snapshot || state.ui.page !== wasPage || modal !== state.ui.modal) return;
      if (state.failNext[wasPage]) {
        const reason = state.failNext[wasPage];
        delete state.failNext[wasPage];
        throw Error(reason + " Повторите действие.");
      }
      if (state.faults) delete state.faults[wasPage];
    }
    await act(name, value);
  } catch (e) {
    if (snapshot === state) {
      state.faults = state.faults || {};
      state.faults[wasPage] = e.message;
    }
  } finally {
    if (snapshot.ui.pending === pending) snapshot.ui.pending = null;
    if (snapshot === state) render(state);
  }
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
    state.ui.fileId = u.fileId;
    state.ui.navMore = u.navMore;
    if (u.page === "task") state.ui.taskId = byId(state.tasks, u.taskId)?.id || state.tasks[0]?.id;
  } else if (id in textFields) {
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
    if (id === "configHost") {
      delete u.form.encoderPath;
      delete u.form.compactPath;
      delete u.form.agentAddress;
    }
    if (id === "moveDisk") {
      delete u.form.source;
      delete u.form.dest;
    }
    if (id === "toolDisk") {
      delete u.form.toolDir;
      delete u.form.toolFile;
    }
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
}
document.addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== "file") updateControl(e.target);
});
document.addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target.type === "file") updateControl(e.target);
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "add-form") {
    e.preventDefault();
    void dispatch("addTorrent", "");
  }
});
function addTorrent() {
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
    infoHash: hash.slice(9),
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
}
document.addEventListener("dragstart", (e) => {
  if (e.target.id === "grab-file") e.dataTransfer.setData("text/plain", operationModel(state).file.id);
});
document.addEventListener("dragover", (e) => {
  if (e.target.closest('[data-action="dest"]')) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const dest = e.target.closest('[data-action="dest"]');
  if (dest) {
    e.preventDefault();
    if (e.dataTransfer.getData("text/plain") === operationModel(state).file.id) void dispatch("dest", dest.dataset.value);
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
  let lastSse = 0;
  let fastBusy = false;
  let heavyBusy = false;
  const paint = (next) => {
    state = next;
    render(state);
  };
  const fail = (error) => {
    state.loading = false;
    state.error = error instanceof Error ? error.message : "Панель не ответила.";
    render(state);
  };
  const runFast = () => {
    if (fastBusy) return;
    fastBusy = true;
    void LiveWire.refreshFast(state)
      .then(paint)
      .catch(fail)
      .finally(() => {
        fastBusy = false;
      });
  };
  const runHeavy = () => {
    if (heavyBusy) return;
    heavyBusy = true;
    void LiveWire.refresh(state)
      .then(paint)
      .catch(fail)
      .finally(() => {
        heavyBusy = false;
      });
  };
  const tick = (reason) => {
    const hidden = typeof document !== "undefined" && document.hidden;
    const plan = LivePoll.pollPlan({ hidden, reason });
    if (plan.heavy) runHeavy();
    else if (plan.fast) runFast();
  };
  requestHeavy = () => tick("navigate");
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick("show");
  });
  LegacyApi.listenJobs(() => {
    const now = Date.now();
    if (!LivePoll.sseDue({ hidden: document.hidden, lastAt: lastSse, now })) return;
    lastSse = now;
    tick("job");
  });
  if (LegacyApi.listenGameMode) {
    LegacyApi.listenGameMode((payload) => {
      if (!payload || typeof payload !== "object") return;
      state.gameMode = payload;
      render(state);
    });
  }
  tick("open");
}
