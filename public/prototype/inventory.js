"use strict";

function inputField(id, label, value, type = "text", extra = "") {
  return `<label class="field">${esc(label)}<input type="${type}" id="${id}" value="${esc(value)}" ${extra}></label>`;
}
function dialogPanel(title, content) {
  return `<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${button("close", icon("X"), "", "icon-button", 'aria-label="Закрыть"')}</div>${content}</div>`;
}
function downloadBlob(filename, content) {
  const url = URL.createObjectURL(new Blob([content]));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const Inventory = (() => {
  function hosts(s) {
    return (
      card("Подключения", button("invHostForm", icon("Plus") + "Добавить хост", "", "primary")) +
      (s.hosts
        .map((h) =>
          card(
            esc(h.name),
            `<p class="info-strip">${esc(h.os)} · ${h.online ? "В сети" : "Не в сети"}</p><p class="task-route">Активных задач · ${s.tasks.filter((j) => j.host === h.id && j.state === "running").length}</p><p class="device-path">${esc(h.address)} · ${esc(h.folder)}</p>${h.probe ? `<p role="status">${esc(h.probe)}</p>` : ""}<div class="file-actions">${button("invProbe", "Проверить связь", h.id)}${button("invHostForm", "Изменить", h.id)}${button("invReset", "Сбросить", h.id)}${button("invRemove", "Удалить", h.id, "danger-action")}</div>`,
          ),
        )
        .join("") || empty("Хостов пока нет. Добавьте первый компьютер."))
    );
  }
  const diskActions = (s, d) =>
    button("invFolder", "Сжать каталог", d.id, "secondary-action", available(s, d) && d.fs === "NTFS" ? "" : "disabled") +
    button("invPickFile", "Скачать файл", d.id, "secondary-action", available(s, d) ? "" : "disabled");
  const fileActions = (s, f) =>
    button("invDownload", "Скачать файл", f.id, "secondary-action", available(s, diskOf(s, f)) ? "" : "disabled");
  const payload = (s, t) => s.files.find((f) => f.torrentId === t.id);
  function torrentTools(s, t) {
    const f = payload(s, t),
      online = available(s, diskOf(s, t));
    return `<div class="file-actions">${button("invHashes", "Посмотреть хеши", t.id)}${button("invRules", "Правила раскладки", t.id)}${button("invMigration", "Перенести на другой хост", t.id, "secondary-action", online && f && t.progress === 100 ? "" : "disabled")}${button("invRemoveTorrent", "Удалить раздачу", t.id, "danger-action", online ? "" : "disabled")}</div>${t.progress < 100 ? empty("Для переноса дождитесь завершения загрузки.") : ""}`;
  }
  function folders(s, d) {
    return [...new Set(s.files.filter((f) => f.diskId === d?.id && !f.allocatedBytes).map((f) => f.dir))];
  }
  function modal(s) {
    const { kind, id } = s.ui.modal,
      form = s.ui.form;
    if (kind === "invHostForm")
      return dialogPanel(
        id ? "Изменить хост" : "Добавить хост",
        `<div class="form-grid">${inputField("hostName", "Имя", form.hostName)}${field("hostOS", "Система", ["Windows", "macOS", "Linux"], form.hostOS)}${inputField("hostAddress", "Адрес Web UI", form.hostAddress, "url")}${inputField("hostFolder", "Каталог загрузок", form.hostFolder)}</div>${button("invSaveHost", "Сохранить", id, "primary")}`,
      );
    if (kind === "invFolder" || kind === "invPickFile") {
      const d = byId(s.disks, id),
        files = s.files.filter((f) => f.diskId === id),
        list = folders(s, d);
      if (kind === "invFolder")
        return dialogPanel(
          "Сжатие каталога · " + d.label,
          list.length
            ? field("compressDir", "Каталог NTFS", list, form.compressDir || list[0]) +
                button("invCompress", "Сжать каталог", id, "primary")
            : empty("Каталогов для сжатия нет."),
        );
      return dialogPanel(
        "Скачать файл · " + d.label,
        files.length
          ? field(
              "downloadFile",
              "Файл",
              files.map((f) => [f.id, f.dir + f.name]),
              form.downloadFile || files[0].id,
            ) + button("invDownload", "Скачать демофайл", form.downloadFile || files[0].id, "primary")
          : empty("На носителе нет файлов."),
      );
    }
    const t = byId(s.torrents, id),
      f = t && payload(s, t);
    if (!t) return dialogPanel("Раздача отсутствует", empty("Снимок больше не содержит раздачу."));
    if (kind === "invHashes") {
      const checksum = f && (s.manifests[f.id] || s.checksums[f.contentId]);
      return dialogPanel(
        "Хеши · " + t.name,
        `<h3>BitTorrent info hash</h3><code class="checksum">${esc(t.infoHash)}</code><h3>SHA-256 файлов</h3>${checksum ? `<b>${esc(f.name)}</b><code class="checksum">${esc(checksum)}</code>` : empty("Манифеста ещё нет.")}<div class="file-actions">${button("invHashRun", "Посчитать SHA-256", id, "secondary-action", f && available(s, diskOf(s, t)) ? "" : "disabled")}${button("invManifest", "Скачать манифест", id, "secondary-action", checksum ? "" : "disabled")}</div>`,
      );
    }
    if (kind === "invRemoveTorrent")
      return dialogPanel(
        "Удаление раздачи",
        field(
          "torrentErase",
          "Что удалить",
          [
            ["keep", "Только раздачу"],
            ["erase", "Раздачу и данные"],
          ],
          form.torrentErase || "keep",
        ) + button("invDeleteChoice", "Далее", id, "danger-action"),
      );
    const targets = migrationTargets(s, t),
      target = byId(targets, form.migrationDisk) || targets[0],
      reason = f ? copyReason(s, f, target) : "Загрузка ещё не завершена.";
    return dialogPanel(
      "Перенести · " + t.name,
      (targets.length
        ? field(
            "migrationDisk",
            "Носитель на другом хосте",
            targets.map((d) => [d.id, hostOf(s, d).name + " · " + d.label]),
            target.id,
          )
        : empty("На другом хосте нет носителей.")) +
        `<p class="route-preview">${esc(reason || "После сверки раздача продолжится на новом хосте. Исходные данные сохранятся до подтверждения.")}</p>` +
        button("invMigrate", "Начать перенос", id, "primary", reason ? "disabled" : ""),
    );
  }
  const migrationTargets = (s, t) =>
    s.disks.filter((d) => d.host !== diskOf(s, t).host && d.kind !== "optical" && d.id !== s.gamePool);
  function compress(d, dir) {
    if (!available(state, d) || d.fs !== "NTFS" || !folders(state, d).includes(dir))
      throw Error("Каталог недоступен для сжатия NTFS.");
    const files = state.files.filter((f) => f.diskId === d.id && f.dir === dir);
    if (
      enqueue(
        "compress",
        "Сжатие · " + d.label + " / " + dir,
        d.host,
        files.reduce((b, f) => b + f.sizeBytes, 0),
        { type: "folderCompress", target: d.id, dir, algorithm: state.toolSettings.algorithm },
      )
    )
      openJob(state.tasks[0].id);
  }
  function act(name, id) {
    const s = state,
      u = s.ui,
      form = u.form,
      h = byId(s.hosts, id),
      d = byId(s.disks, id),
      t = byId(s.torrents, id),
      f = t && payload(s, t);
    switch (name) {
      case "invHostForm":
        u.form = {
          hostName: h?.name || "",
          hostAddress: h?.address || "",
          hostOS: h?.os || "Windows",
          hostFolder: h?.folder || "",
        };
        u.modal = { kind: name, id };
        break;
      case "invSaveHost": {
        let address;
        try {
          address = new URL(form.hostAddress);
        } catch {
          throw Error("Введите полный адрес Web UI с http или https.");
        }
        if (!["http:", "https:"].includes(address.protocol) || !form.hostName?.trim() || !form.hostFolder?.trim())
          throw Error("Укажите имя, HTTP-адрес и каталог загрузок.");
        if (s.hosts.some((row) => row !== h && row.address === address.href.replace(/\/$/, "")))
          throw Error("Хост с этим адресом уже существует.");
        const values = {
          name: form.hostName.trim(),
          address: address.href.replace(/\/$/, ""),
          os: form.hostOS,
          folder: form.hostFolder.trim(),
        };
        if (h) Object.assign(h, values);
        else s.hosts.push({ ...values, id: crypto.randomUUID(), online: true, defaults: { ...values } });
        u.modal = null;
        message("Настройки хоста сохранены.");
        break;
      }
      case "invProbe":
        h.probe = (h.online ? "Связь подтверждена" : "Хост не отвечает") + " · " + scanTime(new Date());
        if (!h.online) throw Error(h.probe);
        break;
      case "invReset":
        askConfirm(
          name,
          id,
          "Сбросить настройки " + h.name + "?",
          "Будут восстановлены исходные настройки и список демораздач этого хоста.",
          "Сбросить",
        );
        break;
      case "invRemove":
        askConfirm(
          name,
          id,
          "Удалить хост " + h.name + "?",
          "Его носители, раздачи, файлы и связанные задачи исчезнут из демокаталога.",
          "Удалить хост",
        );
        break;
      case "invPickFile":
      case "invFolder":
      case "invRemoveTorrent":
      case "invHashes":
      case "invMigration":
        u.form = {};
        u.modal = { kind: name, id };
        break;
      case "invDownload": {
        const file = byId(s.files, id);
        if (!file || !available(s, diskOf(s, file))) throw Error("Носитель недоступен.");
        downloadBlob(file.name, "sklad-demo/" + file.contentId);
        message("Демофайл готов к скачиванию.");
        break;
      }
      case "invCompress":
        compress(d, form.compressDir || folders(s, d)[0]);
        break;
      case "invHashRun":
        navigate("integrity");
        u.form.source = f.id;
        break;
      case "invManifest":
        downloadBlob(t.name + ".sha256", (s.manifests[f.id] || s.checksums[f.contentId]) + "  " + f.name + "\n");
        break;
      case "invRules":
        navigate("policies");
        u.category = categoryFor(t.kind);
        break;
      case "invMigrate": {
        const options = migrationTargets(s, t),
          target = byId(options, form.migrationDisk) || options[0],
          reason = copyReason(s, f, target);
        if (reason) throw Error(reason);
        if (
          enqueue("copy", "Перенос раздачи · " + t.name, diskOf(s, t).host, f.sizeBytes, {
            type: "copy",
            fileId: f.id,
            target: target.id,
            torrentId: id,
            moveSource: true,
          })
        )
          openJob(s.tasks[0].id);
        break;
      }
      case "invDeleteChoice": {
        const erase = form.torrentErase === "erase";
        askConfirm(
          erase ? "invEraseTorrent" : "invKeepData",
          id,
          "Удалить " + t.name + "?",
          erase
            ? "Раздача и данные на её носителе будут удалены."
            : "Данные останутся на носителе. Раздача исчезнет из qBittorrent.",
          "Удалить",
        );
        break;
      }
    }
  }
  function confirmed(kind, id) {
    const s = state;
    if (kind === "invReset") {
      const h = byId(s.hosts, id);
      const base = DemoData.snapshot("normal");
      const ownDisk = new Set(s.disks.filter((d) => d.host === id).map((d) => d.id));
      if (
        s.tasks.some(
          (j) =>
            ["running", "paused"].includes(j.state) &&
            j.operation?.torrentId &&
            (j.host === id || ownDisk.has(j.operation.target)),
        )
      )
        throw Error("Сначала завершите или отмените перенос раздачи.");
      const other = s.torrents.filter((t) => !ownDisk.has(t.diskId));
      const original = base.torrents.filter((t) => ownDisk.has(t.diskId) && !byId(other, t.id));
      s.torrents = [...other, ...original];
      for (const f of s.files.filter((f) => ownDisk.has(f.diskId))) {
        if (f.torrentId && !byId(original, f.torrentId)) delete f.torrentId;
        const fixture = byId(base.files, f.id);
        if (fixture?.torrentId && byId(original, fixture.torrentId)) f.torrentId = fixture.torrentId;
      }
      // If its payload was erased, the restored torrent must download again.
      for (const t of original)
        if (t.progress === 100 && !payload(s, t)) Object.assign(t, { progress: 0, state: "wait", up: 0, down: 0 });
      Object.assign(h, h.defaults, { probe: "" });
      return;
    }
    if (kind === "invRemove") {
      const removed = new Set(s.disks.filter((d) => d.host === id).map((d) => d.id));
      const dead = new Set(s.files.filter((f) => removed.has(f.diskId)).map((f) => f.id));
      s.tasks = s.tasks.filter(
        (j) =>
          j.host !== id &&
          !dead.has(j.operation?.fileId) &&
          !dead.has(j.operation?.other) &&
          !removed.has(j.operation?.target) &&
          j.operation?.peer !== id,
      );
      for (const key of dead) delete s.manifests[key];
      s.files = s.files.filter((f) => !dead.has(f.id));
      s.torrents = s.torrents.filter((t) => !removed.has(t.diskId));
      s.disks = s.disks.filter((d) => !removed.has(d.id));
      s.hosts = s.hosts.filter((h) => h.id !== id);
      s.opticalImages = s.opticalImages.filter((img) => !removed.has(img.diskId));
      if (s.opticalDrive?.host === id) s.opticalDrive = null;
      for (const r of Object.values(s.rules)) if (removed.has(r.target)) r.target = "group";
      return;
    }
    const t = byId(s.torrents, id),
      file = payload(s, t),
      d = diskOf(s, t);
    if (!available(s, d)) throw Error("Хост раздачи недоступен.");
    if (
      s.tasks.some(
        (j) =>
          ["running", "paused"].includes(j.state) &&
          (j.operation?.torrentId === id || (file && j.operation?.fileId === file.id)),
      )
    )
      throw Error("Сначала завершите или отмените связанную задачу.");
    if (kind === "invEraseTorrent") {
      d.freeBytes = Math.min(
        d.sizeBytes,
        d.freeBytes + (file ? (file.allocatedBytes ?? file.sizeBytes) : Math.round(((t.sizeBytes || 0) * t.progress) / 100)),
      );
      if (file) {
        s.files = s.files.filter((f) => f !== file);
        delete s.manifests[file.id];
      }
    } else if (file) delete file.torrentId;
    else if (t.progress > 0)
      s.files.push({
        id: crypto.randomUUID(),
        contentId: "partial:" + id,
        name: t.name + ".part",
        dir: "Downloads/",
        diskId: d.id,
        sizeBytes: Math.round((t.sizeBytes * t.progress) / 100),
        type: "Данные",
      });
    s.torrents = s.torrents.filter((row) => row !== t);
    rebalance();
  }
  return { hosts, diskActions, fileActions, torrentTools, modal, act, confirmed, folders, compress };
})();
