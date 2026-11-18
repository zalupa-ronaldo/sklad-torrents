"use strict";

const Workshops = (() => {
  function local(s) {
    const options = s.sendSettings,
      form = s.ui.form;
    const peers = [...s.hosts, ...s.devices],
      remote = peers.filter((p) => p.online && options.discovery);
    const list = options.discovery
      ? peers.map((p) => `<li><b>${esc(p.name)}</b><span>${p.online ? "В сети" : "Не в сети"}</span></li>`).join("")
      : "";
    const disks = s.disks.filter((d) => d.kind !== "optical" && d.id !== s.gamePool);
    return (
      card(
        "Устройства рядом",
        (list
          ? `<ul class="record-list">${list}</ul>`
          : empty(options.discovery ? "Соседние устройства не найдены." : "Поиск устройств выключен.")) +
          button("shopDiscover", "Обновить список", "", "secondary-action", options.discovery ? "" : "disabled"),
      ) +
      (remote.length ? operationPage(s) : card("Передача файла", empty("Для передачи нужен доступный получатель."))) +
      card(
        "Настройки LocalSend",
        `<div class="form-grid">${inputField("sendAlias", "Имя в сети", form.sendAlias ?? options.alias)}${inputField("sendPort", "Порт", form.sendPort ?? options.port, "number", 'min="1" max="65535"')}${field("sendDiscover", "Обнаружение устройств", ["Включено", "Выключено"], form.sendDiscover || (options.discovery ? "Включено" : "Выключено"))}${field(
          "sendInbox",
          "Приём по умолчанию",
          disks.map((d) => [d.id, d.label + " / Inbox"]),
          form.sendInbox || options.inbox,
        )}</div>${button("shopSendSettings", "Сохранить настройки", "", "primary")}`,
      )
    );
  }
  function optical(s) {
    const drive = s.opticalDrive,
      online = drive && byId(s.hosts, drive.host)?.online;
    const images = s.opticalImages.filter((img) => byId(s.files, img.fileId));
    const list = images
      .map(
        (i) =>
          `<li><span><b>${esc(i.name)}</b><small>${esc(byId(s.disks, i.diskId)?.label)} · ${bytes(i.sizeBytes)}</small></span>${button("shopSelectImage", "Выбрать для записи", i.id, "secondary-action", online && !drive.open && drive.writable ? "" : "disabled")}</li>`,
      )
      .join("");
    if (!drive)
      return card("Приводы", empty("Оптические приводы не обнаружены.")) + card("Образы", empty("Образов пока нет."));
    return (
      card(
        esc(drive.name),
        `<p class="info-strip">${online ? "В сети" : "Не в сети"} · ${drive.open ? "Лоток открыт" : drive.writable ? "Чистый носитель · " + esc(drive.medium) : "Диск записан"}</p>${drive.open ? field("blankMedium", "Чистый носитель", Object.keys(mediaCapacity), s.ui.form.blankMedium || drive.medium) : ""}<div class="file-actions">${button("shopTray", drive.open ? "Закрыть лоток" : "Открыть лоток", "", "secondary-action", online ? "" : "disabled")}${button("shopBlank", "Вставить чистый носитель", "", "secondary-action", online && drive.open ? "" : "disabled")}</div>`,
      ) +
      card("Образы", list ? `<ul class="record-list">${list}</ul>` : empty("Дисковых образов пока нет.")) +
      operationPage(s)
    );
  }
  function ruleCandidates(s, cat) {
    const r = s.rules[cat];
    if (!r) return [];
    return s.torrents
      .filter((t) => categoryFor(t.kind) === cat)
      .map((t) => {
        const f = s.files.find((f) => f.torrentId === t.id),
          d = f && placement(r, f.sizeBytes);
        let reason = f && available(s, diskOf(s, f)) ? "" : "Ожидает загрузки или подключения";
        if (!reason && !d) reason = "Нет места или связи";
        if (!reason && s.files.some((c) => c.diskId === d.id && c.dir === r.folder + "/" && c.name === f.name))
          reason = "Уже размещено";
        return { t, f, d, reason };
      });
  }
  function rules(s) {
    const cats = Object.keys(s.rules);
    if (!cats.length) return card("Правила раскладки", empty("В текущем снимке нет правил."));
    const cat = s.ui.category,
      plan = ruleCandidates(s, cat);
    return (
      card(
        "Правила",
        `<div class="queue-filters">${cats.map((c) => button("shopRule", esc(c), c, "secondary-action", `aria-pressed="${c === cat}"`)).join("")}</div>`,
      ) +
      policyPage(s) +
      card(
        "Размещение · " + esc(cat),
        (plan
          .map(
            ({ t, d, reason }) =>
              `<p class="info-strip"><b>${esc(t.name)}</b> · ${esc(reason || d.label + " / " + s.rules[cat].folder)}</p>`,
          )
          .join("") || empty("Раздач этой категории пока нет.")) +
          button(
            "shopApply",
            "Применить правило",
            "",
            "primary",
            s.previewFresh && plan.some((row) => !row.reason) ? "" : "disabled",
          ),
      )
    );
  }
  function games(s) {
    const count = new Set(
      s.files.filter((f) => f.platform && (s.ui.platform === "Все" || s.ui.platform === f.platform)).map((f) => f.contentId),
    ).size;
    return `<p class="collection-count">Игр на полке · ${count}</p>` + gameShelf(s);
  }
  function act(name, id) {
    const s = state,
      form = s.ui.form;
    switch (name) {
      case "shopDiscover":
        message("Поиск завершён. Устройств в сети · " + [...s.hosts, ...s.devices].filter((p) => p.online).length);
        break;
      case "shopSendSettings": {
        const opts = s.sendSettings,
          alias = (form.sendAlias ?? opts.alias).trim(),
          port = Number(form.sendPort ?? opts.port);
        if (!alias || !Number.isInteger(port) || port < 1 || port > 65535) throw Error("Укажите имя и порт от 1 до 65535.");
        Object.assign(opts, {
          alias,
          port,
          discovery: (form.sendDiscover ?? (opts.discovery ? "Включено" : "Выключено")) === "Включено",
          inbox: form.sendInbox || opts.inbox,
        });
        message("Настройки LocalSend сохранены.");
        break;
      }
      case "shopTray":
      case "shopBlank": {
        const d = s.opticalDrive;
        if (!d || !byId(s.hosts, d.host)?.online) throw Error("Привод не в сети.");
        if (s.tasks.some((j) => ["paused", "running"].includes(j.state) && j.operation?.type === "burn"))
          throw Error("Дождитесь завершения записи.");
        if (name === "shopTray") d.open = !d.open;
        else if (d.open) {
          d.open = false;
          d.writable = true;
          d.medium = form.blankMedium || d.medium;
          form.medium = d.medium;
        }
        break;
      }
      case "shopSelectImage": {
        const image = byId(s.opticalImages, id);
        Object.assign(form, { source: image.fileId, opt: "Записать и проверить", medium: s.opticalDrive.medium });
        message("Образ выбран для записи.");
        break;
      }
      case "shopRule":
        s.ui.category = id;
        break;
      case "shopApply": {
        let count = 0;
        const r = s.rules[s.ui.category];
        if (!s.previewFresh) throw Error("Сначала выполните пробный прогон.");
        for (const { t, f, d, reason } of ruleCandidates(s, s.ui.category)) {
          if (
            !reason &&
            enqueue("placement", "Раскладка · " + t.name, diskOf(s, f).host, f.sizeBytes, {
              type: "place",
              torrentId: t.id,
              fileId: f.id,
              target: d.id,
              dir: r.folder + "/",
            })
          )
            count++;
        }
        if (count) navigate("jobs");
        else throw Error("Нет доступных файлов для раскладки.");
        break;
      }
    }
  }
  return { local, optical, rules, games, act };
})();
