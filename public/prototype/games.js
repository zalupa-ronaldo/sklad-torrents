"use strict";

const GameLibrary = (() => {
  const labels = {
    compressed: "Сжато",
    queued: "В очереди",
    compressing: "Сжимается",
    plain: "Не сжато",
    partial: "Частично разжата после обновления",
  };
  const durations = [5, 3, 2, 5, 2];
  const source = (s, g) => byId(s.files, g.fileId);
  const moveOf = (s, g) =>
    s.tasks.find(
      (j) =>
        j.operation?.type === "libraryMove" &&
        j.operation.gameId === g.id &&
        ["running", "paused", "error"].includes(j.state),
    );
  const occupied = (f) => f.allocatedBytes ?? f.sizeBytes;
  const onSSD = (s, g) => source(s, g)?.diskId === s.gamePool;
  const targetId = (s, g) => (onSSD(s, g) ? g.archiveId : s.gamePool);
  const diskName = (s, id) => byId(s.disks, id)?.label || "Отключённый диск";
  const recordPath = (s, g, f) => ((byId(s.disks, f.diskId)?.mount || g.archivePath) + f.dir + f.name).replaceAll("/", "\\");
  const effectiveStatus = (s, g) => {
    const j = moveOf(s, g);
    return j?.flow.step === 3 ? "compressing" : g.status;
  };
  const progressOf = (s, g) => {
    const j = moveOf(s, g);
    return j?.flow.step === 3 ? Math.floor(j.flow.percent) : Math.floor(g.progress);
  };
  function reason(s, g) {
    const f = source(s, g),
      d = byId(s.disks, targetId(s, g));
    if (g.running) return "Игра запущена. Закройте её перед переносом.";
    if (s.gameAgentError) return "Агент Windows PC не отвечает.";
    if (!f || !available(s, byId(s.disks, f.diskId))) return "Исходный диск офлайн.";
    if (!available(s, d)) return "Диск назначения офлайн.";
    if (moveOf(s, g)) return "Перенос уже создан.";
    if (g.status === "compressing") return "Дождитесь окончания сжатия.";
    if (s.tasks.some((j) => ["running", "paused"].includes(j.state) && j.operation?.fileId === f.id))
      return "Файлы заняты другой задачей.";
    if (s.files.some((c) => c.diskId === d.id && c.dir === f.dir && c.name === f.name))
      return "На целевом диске уже есть такая папка.";
    if (d.freeBytes < f.sizeBytes) return "Не хватает " + bytes(f.sizeBytes - d.freeBytes) + " на " + d.label + ".";
    return "";
  }
  function start(s, g, destination) {
    if (g.running) {
      s.ui.modal = { kind: "winRunning", id: g.id };
      return;
    }
    if (targetId(s, g) !== destination) return;
    const blocked = reason(s, g);
    if (blocked) {
      message(blocked);
      return;
    }
    const f = source(s, g),
      d = byId(s.disks, destination);
    const op = { type: "libraryMove", fileId: f.id, gameId: g.id, target: d.id };
    if (!enqueue("copy", "Перенос игры · " + g.title, "pc", f.sizeBytes, op)) return;
    d.freeBytes -= f.sizeBytes;
    const j = s.tasks[0];
    j.flow = { from: f.diskId, step: 0, percent: 0, reserved: f.sizeBytes, sourceStatus: g.status, confirmed: false };
    j.etaSec = durations.slice(0, 4).reduce((a, b) => a + b, 0);
    message("Начат перенос на " + d.label + ".");
    return j;
  }
  function resetCopy(s, j, g) {
    const flow = j.flow,
      d = byId(s.disks, j.operation.target),
      copy = byId(s.files, j.copyId);
    if (copy) {
      if (d) d.freeBytes += occupied(copy);
      s.files = s.files.filter((f) => f !== copy);
      delete s.manifests[copy.id];
    } else if (d) d.freeBytes += flow.reserved;
    g.fileId = j.operation.fileId;
    g.status = flow.sourceStatus;
    j.copyId = null;
    j.verified = false;
    flow.reserved = 0;
    flow.confirmed = false;
  }
  function fail(s, j, g, why) {
    resetCopy(s, j, g);
    j.state = "error";
    j.error = why;
    j.bytesPerSec = 0;
    j.etaSec = null;
    recordEvent(j, why);
  }
  function safeRemove(s, j) {
    const f = byId(s.files, j.operation.fileId),
      copy = byId(s.files, j.copyId),
      g = byId(s.gameLibrary, j.operation.gameId);
    return (
      g &&
      !g.running &&
      !s.gameAgentError &&
      f &&
      copy &&
      f !== copy &&
      f.diskId === j.flow.from &&
      copy.diskId === j.operation.target &&
      g.fileId === copy.id &&
      f.contentId === copy.contentId &&
      f.sizeBytes === copy.sizeBytes &&
      available(s, byId(s.disks, f.diskId)) &&
      available(s, byId(s.disks, copy.diskId)) &&
      j.verified &&
      j.checksum &&
      j.checksum === s.manifests[copy.id] &&
      j.checksum === (s.manifests[f.id] || s.checksums[f.contentId])
    );
  }
  function confirm(s, id) {
    const j = byId(s.tasks, id);
    if (!j || j.flow.step !== 4 || !safeRemove(s, j))
      throw Error("Удаление недоступно. Проверьте игру, носители и результат сверки.");
    j.flow.confirmed = true;
    j.state = "running";
    recordEvent(j, "Удаление исходной папки подтверждено.");
  }
  function ask(s, j) {
    if (!safeRemove(s, j)) {
      message("Исходник сохранён. Для удаления нужны обе проверенные копии в сети.");
      return;
    }
    const g = byId(s.gameLibrary, j.operation.gameId),
      f = byId(s.files, j.operation.fileId);
    askConfirm(
      "winDelete",
      j.id,
      "Удалить исходную папку?",
      recordPath(s, g, f) +
        " · " +
        bytes(occupied(f)) +
        ". Проверенная копия останется на " +
        diskName(s, j.operation.target) +
        ".",
      "Удалить источник",
    );
  }
  async function verify(s, j, g) {
    if (j.flow.checking) return;
    j.flow.checking = true;
    try {
      const copy = byId(s.files, j.copyId),
        f = byId(s.files, j.operation.fileId);
      const digest = await fixtureDigest(copy.contentId);
      if (s !== state || !s.tasks.includes(j) || j.state !== "running") return;
      if (!f || copy.sizeBytes !== f.sizeBytes || digest !== (s.manifests[f.id] || s.checksums[f.contentId]))
        throw Error("SHA-256 не совпал. Исходник сохранён.");
      s.manifests[copy.id] = digest;
      j.checksum = digest;
      j.verified = true;
      j.flow.step = 2;
      j.flow.percent = 0;
      recordEvent(j, "Целостность копии подтверждена.");
    } catch (e) {
      if (s === state && s.tasks.includes(j) && j.state === "running") fail(s, j, g, e.message);
    } finally {
      j.flow.checking = false;
      if (s === state) render(s);
    }
  }
  function tickMove(s, j, seconds) {
    const g = byId(s.gameLibrary, j.operation.gameId),
      f = byId(s.files, j.operation.fileId),
      d = byId(s.disks, j.operation.target),
      v = j.flow;
    const copyMissing = v.step > 0 && !byId(s.files, j.copyId);
    if (
      !g ||
      !f ||
      copyMissing ||
      s.gameAgentError ||
      !available(s, d) ||
      !available(s, byId(s.disks, v.from)) ||
      g.running
    ) {
      if (g) fail(s, j, g, "Перенос прерван. Проверьте доступность игры и обоих дисков.");
      return;
    }
    v.percent = Math.min(100, v.percent + (100 * seconds) / durations[v.step]);
    j.progress = (v.step + v.percent / 100) * 20;
    j.bytesPerSec = v.step === 0 ? Math.ceil(f.sizeBytes / durations[0]) : 0;
    j.etaSec = Math.ceil(
      durations[v.step] * (1 - v.percent / 100) + durations.slice(v.step + 1, v.step < 4 ? 4 : 5).reduce((a, b) => a + b, 0),
    );
    if (v.percent < 100) return;
    if (v.step === 0) {
      if (s.files.some((c) => c.diskId === d.id && c.name === f.name && c.dir === f.dir)) {
        fail(s, j, g, "Целевая папка уже существует.");
        return;
      }
      const copy = { ...f, id: crypto.randomUUID(), diskId: d.id, allocatedBytes: f.sizeBytes };
      delete copy.torrentId;
      s.files.push(copy);
      j.copyId = copy.id;
      v.reserved = 0;
    } else if (v.step === 1) {
      void verify(s, j, g);
      return;
    } else if (v.step === 2) {
      g.fileId = j.copyId;
      recordEvent(j, g.launcher === "Без лаунчера" ? "Путь запуска обновлён." : "Обновлён путь " + g.launcher + ".");
    } else if (v.step === 3) {
      const copy = byId(s.files, j.copyId),
        saved = Math.round((copy.sizeBytes * g.community.percent) / 100);
      copy.allocatedBytes = copy.sizeBytes - saved;
      d.freeBytes += saved;
      g.status = "compressed";
      g.progress = 100;
      j.state = "paused";
      j.bytesPerSec = 0;
      j.etaSec = null;
      recordEvent(j, "Ожидает подтверждения удаления источника.");
    } else {
      if (!v.confirmed || !safeRemove(s, j)) {
        j.state = "paused";
        v.confirmed = false;
        v.percent = 0;
        return;
      }
      byId(s.disks, v.from).freeBytes += occupied(f);
      s.files = s.files.filter((c) => c !== f);
      delete s.manifests[f.id];
      g.history.unshift({ at: new Date().toISOString(), from: v.from, to: d.id });
      j.sourceDeleted = true;
      j.state = "done";
      j.bytesPerSec = 0;
      j.etaSec = 0;
      recordEvent(j, "Исходная папка удалена. Перенос завершён.");
      message("Перенос завершён · " + g.title);
    }
    v.step++;
    v.percent = 0;
  }
  function taskAction(s, j, name) {
    const g = byId(s.gameLibrary, j.operation.gameId);
    if (name === "cancel" && ["running", "paused"].includes(j.state)) {
      resetCopy(s, j, g);
      j.state = "cancelled";
      s.cancelled.push(j);
      s.tasks = s.tasks.filter((t) => t !== j);
      recordEvent(j, "Перенос отменён. Исходник сохранён.");
      return;
    }
    if (name === "retry" && j.state === "error") {
      s.tasks = s.tasks.filter((t) => t !== j);
      const blocked = reason(s, g);
      if (blocked) {
        s.tasks.push(j);
        message(blocked);
        return;
      }
      const retry = start(s, g, j.operation.target);
      if (retry) {
        retry.id = j.id;
        retry.events = [...j.events, ...retry.events];
      }
      return;
    }
    if (name === "pause" && j.state === "paused" && j.flow.step === 4 && !j.flow.confirmed) {
      ask(s, j);
      return;
    }
    if (name === "pause") {
      j.state = j.state === "running" ? "paused" : "running";
      recordEvent(j, j.state === "paused" ? "Перенос приостановлен." : "Перенос продолжен.");
    }
  }
  function tickCompression(s, seconds) {
    if (s.gameAgentError || !byId(s.hosts, "pc")?.online) return false;
    const ready = (g) => {
      const f = source(s, g);
      return f && available(s, byId(s.disks, f.diskId)) && !moveOf(s, g) && !g.running;
    };
    const g =
      s.gameLibrary.find((g) => g.status === "compressing" && ready(g)) ||
      s.gameLibrary.find((g) => g.status === "queued" && ready(g));
    if (!g) return false;
    g.status = "compressing";
    g.progress = Math.min(100, g.progress + seconds * 0.5);
    if (g.progress === 100) {
      const f = source(s, g),
        after = Math.min(occupied(f), Math.round(f.sizeBytes * (1 - g.community.percent / 100)));
      byId(s.disks, f.diskId).freeBytes += occupied(f) - after;
      f.allocatedBytes = after;
      g.status = "compressed";
    }
    return true;
  }
  function statusBadge(s, g) {
    const status = effectiveStatus(s, g);
    return `<span class="wg-status wg-${status}">${icon({ compressed: "Check", compressing: "Activity", queued: "Clock3", partial: "Layers3", plain: "Box" }[status])}${labels[status]}${status === "compressing" ? " · " + progressOf(s, g) + "%" : ""}</span>`;
  }
  function steps(s, g, j) {
    const v = j.flow,
      toSSD = j.operation.target === s.gamePool;
    const names = [
      toSSD ? "Копирование на SSD" : "Копирование в архив",
      "Проверка SHA-256",
      g.launcher === "Без лаунчера" ? "Обновление пути запуска" : "Обновление пути в " + g.launcher,
      toSSD ? "Сжатие на SSD" : "Сжатие в архиве",
      toSSD ? "Удаление из архива" : "Удаление с SSD",
    ];
    const rows = names
      .map((name, i) => {
        const pct = i < v.step ? 100 : i === v.step ? Math.floor(v.percent) : 0;
        return `<li><div><span>${esc(name)}</span><b>${pct}%</b></div>${meter(pct, name)}</li>`;
      })
      .join("");
    let controls = "";
    if (j.state === "error")
      controls = `<p class="error-message">${esc(j.error)}</p>` + button("retry", "Повторить перенос", j.id);
    else if (v.step === 4 && !v.confirmed)
      controls = button("winAsk", "Подтвердить удаление", j.id, "danger-action", safeRemove(s, j) ? "" : "disabled");
    return `<div class="wg-flow"><p>${j.state === "error" ? "Ошибка переноса" : v.step === 4 && !v.confirmed ? "Копия готова · источник сохранён" : toSSD ? "Перенос на SSD" : "Возврат в архив"}</p><ol>${rows}</ol>${controls}</div>`;
  }
  function gameCard(s, g, featured = false) {
    const f = source(s, g),
      d = byId(s.disks, f.diskId),
      j = moveOf(s, g),
      blocked = reason(s, g),
      after = occupied(f);
    const savings = f.sizeBytes ? 100 * (1 - after / f.sizeBytes) : 0;
    const actionName = onSSD(s, g) ? "winArchive" : "winPlay";
    const warning = !j && blocked ? `<small class="wg-warn">${esc(blocked)}</small>` : "";
    return `<article class="wg-item ${featured ? "wg-feature" : ""}" data-game-id="${esc(g.id)}" draggable="${!blocked}" data-game-drag="${esc(g.id)}">
      <button type="button" class="wg-cover" ${action("winDetails", g.id)} aria-label="Детали игры · ${esc(g.title)}"><img src="${esc((featured && g.portrait) || g.cover)}" alt="" draggable="false"></button>
      <div class="wg-body"><div class="wg-title">${button("winDetails", esc(g.title), g.id, "wg-name")}${g.running ? button("winRunning", icon("Play") + "Запущена", g.id, "wg-live") : ""}</div>
      <p class="wg-location"><b>${esc(g.launcher)}</b><span>${esc(d.label)}${available(s, d) ? "" : " · офлайн"}</span></p>
      <div class="wg-size"><span aria-label="До сжатия">${bytes(f.sizeBytes)}</span> → <strong aria-label="На диске">${bytes(after)}</strong><em>${savings ? "−" : ""}${num(savings)}%</em></div>
      ${statusBadge(s, g)}${effectiveStatus(s, g) === "compressing" ? meter(progressOf(s, g), "Сжатие " + g.title) : ""}
      ${j ? steps(s, g, j) : `<div class="wg-action">${button(actionName, onSSD(s, g) ? "Вернуть в архив" : "В Играю сейчас", g.id, "secondary-action", blocked ? "disabled" : "")}${warning}</div>`}
      </div></article>`;
  }
  function modal(s) {
    const g = byId(s.gameLibrary, s.ui.modal.id),
      f = g && source(s, g);
    if (!f) return dialogPanel("Игра отсутствует", empty("Игры нет в текущем снимке."));
    if (s.ui.modal.kind === "winRunning")
      return dialogPanel(
        "Игра запущена",
        `<p>${esc(g.title)} сейчас работает на Windows PC. Перенос станет доступен после выхода из игры.</p><div class="file-actions">${button("winStop", "Завершить игру в демо", g.id, "primary", available(s, byId(s.disks, f.diskId)) && !s.gameAgentError ? "" : "disabled")}${button("close", "Назад")}${button("winArchive", "Перенести", g.id, "secondary-action", "disabled")}</div>`,
      );
    const facts = [
      ["Путь установки", recordPath(s, g, f)],
      ["Лаунчер", g.launcher],
      ["Steam AppID", g.appId],
      ["Алгоритм CompactGUI", g.algorithm],
      ["Последний запуск", dateText(g.lastPlayed)],
    ];
    const history = g.history
      .map((h) => `<li><time>${dateText(h.at)}</time> ${esc(diskName(s, h.from))} → ${esc(diskName(s, h.to))}</li>`)
      .join("");
    return dialogPanel(
      g.title,
      `<img class="wg-detail-cover" src="${esc(g.cover)}" alt="">${statusBadge(s, g)}<dl>${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      <h3>База сообщества CompactGUI</h3><p>Ожидаемая экономия · <b>${num(g.community.percent)}%</b> (${bytes((f.sizeBytes * g.community.percent) / 100)}). Замеров · ${g.community.samples}. Алгоритм · ${g.algorithm}.</p>
      <h3>История переносов</h3>${history ? `<ul class="wg-history">${history}</ul>` : empty("Переносов ещё не было.")}${g.running ? button("winRunning", "Почему перенос недоступен?", g.id) : onSSD(s, g) ? button("winLaunch", "Запустить в демо", g.id, "secondary-action", !moveOf(s, g) && !s.gameAgentError && available(s, byId(s.disks, f.diskId)) ? "" : "disabled") : ""}`,
    );
  }
  function page(s) {
    if (s.loading) return skeleton("Загрузка библиотеки Windows", 6);
    const all = s.gameLibrary.filter((g) => source(s, g)),
      pool = byId(s.disks, s.gamePool);
    if (!all.length) return card("Библиотека Windows", empty("В каталоге пока нет установленных Windows-игр."));
    const form = s.ui.form,
      q = (form.winSearch || "").trim().toLocaleLowerCase("ru");
    const listed = all.filter(
      (g) =>
        (!q || g.title.toLocaleLowerCase("ru").includes(q)) &&
        (!form.winLauncher || form.winLauncher === g.launcher) &&
        (!form.winDisk || source(s, g).diskId === form.winDisk) &&
        (!form.winStatus || effectiveStatus(s, g) === form.winStatus),
    );
    const sort = form.winSort || "name";
    const rank = (g) =>
      sort === "size"
        ? occupied(source(s, g))
        : sort === "saving"
          ? source(s, g).sizeBytes - occupied(source(s, g))
          : sort === "recent"
            ? Date.parse(g.lastPlayed)
            : 0;
    listed.sort((a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title, "ru"));
    const total = listed.reduce((v, g) => v + source(s, g).sizeBytes, 0),
      used = listed.reduce((v, g) => v + occupied(source(s, g)), 0);
    const featured = all.filter((g) => {
      const j = moveOf(s, g);
      return j ? j.operation.target === s.gamePool || j.flow.from === s.gamePool : onSSD(s, g);
    });
    const now = `<section class="wg-now" data-game-drop="ssd" aria-label="Играю сейчас"><div class="wg-section-head"><h2>${icon("Gamepad2")}Играю сейчас <span class="count">${featured.length}</span></h2><span class="wg-space">${icon("HardDrive")}${esc(pool?.label || "SSD")} · ${available(s, pool) ? bytes(pool.freeBytes) + " свободно" : "офлайн"}</span></div>
      <div class="wg-feature-grid">${featured.map((g) => gameCard(s, g, true)).join("") || empty("Добавьте игру из библиотеки.")}</div><p class="wg-drop-hint">${icon("ArrowDownUp")}Перетащите сюда игру из архива</p></section>`;
    const disks = s.disks.filter((d) => all.some((g) => source(s, g).diskId === d.id));
    const controls = `<div class="wg-section-head"><h2>Библиотека Windows</h2><div class="wg-views">${button("winView", icon("LayoutDashboard") + "Сетка", "grid", "", `aria-pressed="${form.winView !== "list"}"`)}${button("winView", icon("Menu") + "Список", "list", "", `aria-pressed="${form.winView === "list"}"`)}</div></div>
      <div class="wg-controls">${search("winSearch", "Поиск по названию", form.winSearch || "")}${field("winLauncher", "Лаунчер", [["", "Все лаунчеры"], ...new Set(all.map((g) => g.launcher))], form.winLauncher || "")}${field("winDisk", "Носитель", [["", "Все диски"], ...disks.map((d) => [d.id, d.label])], form.winDisk || "")}${field("winStatus", "CompactGUI", [["", "Все статусы"], ...Object.entries(labels)], form.winStatus || "")}${field(
        "winSort",
        "Сортировка",
        [
          ["name", "По названию"],
          ["size", "По размеру на диске"],
          ["saving", "По экономии места"],
          ["recent", "По последнему запуску"],
        ],
        sort,
      )}</div>`;
    const summary = `<div class="wg-summary" role="status"><span>Игр <b>${listed.length}</b></span><span>На дисках <b>${bytes(used)}</b></span><span>Сэкономлено <b>${bytes(total - used)}</b></span></div>`;
    const retry = s.gameAgentError
      ? `<div class="action-fault" role="alert">Ошибка агента ПК. Доступен последний снимок. ${button("winReconnect", "Повторить связь")}</div>`
      : "";
    return (
      retry +
      `<div class="wg-toolbar">${controls}${summary}</div>` +
      now +
      `<section class="wg-library" data-game-drop="archive" aria-label="Библиотека и возврат в архив"><div class="wg-section-head"><h2>Все игры <span class="count">${listed.length}</span></h2><span class="wg-return-hint">Перетащите сюда игру с SSD, чтобы вернуть в архив</span></div>
      <div class="wg-shelf ${form.winView === "list" ? "wg-list" : ""}">${listed.map((g) => gameCard(s, g)).join("") || empty("По этим условиям игр нет.") + button("winClear", "Сбросить фильтры")}</div></section>`
    );
  }
  function act(s, name, id) {
    const g = byId(s.gameLibrary, id);
    switch (name) {
      case "winStop":
        askConfirm(
          "winStop",
          g.id,
          "Завершить игру в демо?",
          g.title + " будет закрыта. Затем её можно будет вернуть в архив.",
          "Завершить игру",
        );
        break;
      case "winLaunch":
        if (!moveOf(s, g) && onSSD(s, g) && !s.gameAgentError && available(s, byId(s.disks, source(s, g).diskId))) {
          g.running = true;
          g.lastPlayed = new Date().toISOString();
          s.ui.modal = { kind: "winRunning", id };
        }
        break;
      case "winDetails":
      case "winRunning":
        s.ui.modal = { kind: name, id };
        break;
      case "winReconnect":
        s.gameAgentError = false;
        delete s.faults.games;
        delete s.failNext.games;
        message("Связь с агентом восстановлена.");
        break;
      case "winView":
        s.ui.form.winView = id;
        break;
      case "winClear":
        for (const key of ["winLauncher", "winDisk", "winStatus", "winSearch"]) delete s.ui.form[key];
        break;
      case "winPlay":
        if (g) start(s, g, s.gamePool);
        break;
      case "winArchive":
        if (g) start(s, g, g.archiveId);
        break;
      case "winAsk":
        ask(s, byId(s.tasks, id));
        break;
    }
  }
  return { page, modal, act, confirm, taskAction, tickMove, tickCompression };
})();
