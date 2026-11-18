"use strict";

function openJob(id) {
  navigate("task");
  state.ui.taskId = id;
}
function recordEvent(job, text) {
  (job.events ??= []).push({ time: new Date().toISOString(), text });
}
function taskLabel(j) {
  return { running: "Выполняется", paused: "На паузе", error: "Ошибка", done: "Готово", cancelled: "Отменено" }[j.state];
}
function categoryFor(kind) {
  return { image: "Софт", video: "Фильмы", audio: "Музыка", game: "Игры" }[kind] || "Прочее";
}
const Pipeline = (() => {
  function sourceDeleteReason(s, j) {
    const op = j?.operation,
      f = byId(s.files, op?.fileId),
      copy = byId(s.files, j?.copyId);
    if (j?.sourceDeleted) return "Исходник удалён.";
    if (j?.state !== "done" || !j.verified || !f || !copy || f === copy || copy.diskId === f.diskId)
      return "Нужна проверенная копия на другом носителе.";
    if (!available(s, diskOf(s, f)) || !available(s, diskOf(s, copy))) return "Подключите оба носителя.";
    if (
      !j.checksum ||
      (s.manifests[f.id] || s.checksums[f.contentId] || j.sourceChecksum) !== j.checksum ||
      s.manifests[copy.id] !== j.checksum ||
      f.sizeBytes !== copy.sizeBytes ||
      f.contentId !== copy.contentId
    )
      return "Контрольные суммы или размеры различаются.";
    if (f.torrentId) return "Исходник используется раздачей. Перенесите раздачу на другой хост.";
    if (
      s.tasks.some(
        (x) => x !== j && ["paused", "running"].includes(x.state) && [f.id, copy.id].includes(x.operation?.fileId),
      )
    )
      return "Файл задействован в другой задаче.";
    return "";
  }
  function taskPage(s) {
    const j = byId(s.tasks, s.ui.taskId) || byId(s.cancelled, s.ui.taskId);
    if (!j)
      return card("Задача отсутствует", empty("Этой задачи нет в текущем снимке.") + button("page", "К очереди", "jobs"));
    const op = j.operation || {},
      f = byId(s.files, op.fileId),
      d = byId(s.disks, op.target),
      copy = byId(s.files, j.copyId);
    const active = ["running", "paused"].includes(j.state);
    const controls = active
      ? button(
          "pause",
          j.state === "running" ? "Пауза" : "Продолжить",
          j.id,
          "secondary-action",
          j.state === "paused" && !taskAvailable(s, j) ? "disabled" : "",
        ) + button("cancel", "Отмена", j.id)
      : j.state === "error"
        ? button("retry", "Повторить", j.id, "secondary-action", taskAvailable(s, j) ? "" : "disabled")
        : "";
    const progress = card(
      esc(j.title),
      `<p>${esc(byId(s.hosts, j.host)?.name || "Хост отключён")} · ${taskLabel(j)}</p>${meter(j.progress, j.title)}<p class="task-route">${num(j.progress)}% · ${bytes(j.bytesPerSec)}/с · ETA ${j.etaSec == null ? "—" : num(j.etaSec) + " с"}</p><p class="device-path">${esc(f ? pathOf(s, f) : j.sourcePath || "")}${d ? " → " + esc(d.label) : ""}</p>${j.error ? `<p class="error-message">${esc(j.error)}</p>` : ""}<div class="file-actions">${controls}</div>`,
    );
    const src = j.sourceChecksum || s.manifests[f?.id] || s.checksums[f?.contentId],
      dest = s.manifests[copy?.id] || op.hashes?.[op.other];
    let integrity = "";
    if (["sha256", "copy", "place"].includes(op.type)) {
      const reason = sourceDeleteReason(s, j);
      integrity = card(
        "Проверка целостности",
        `<h3>SHA-256 источника</h3><code class="checksum">${esc(src || "Ожидает чтения")}</code><h3>SHA-256 копии</h3><code class="checksum">${esc(dest || "Ожидает сверки")}</code><p>${j.verified ? "Контрольные суммы совпали" : op.type === "sha256" && j.state === "done" ? (op.other ? (src === dest ? "Файлы совпали" : "Файлы различаются") : "Манифест записан") : "Сверка ещё не подтверждена"}</p>${op.type === "copy" ? `<div class="file-actions">${button("pipeDelete", "Удалить источник", j.id, "danger-action", reason ? "disabled" : "")}</div><small>${esc(reason || "Проверенная копия останется на месте.")}</small>` : ""}`,
      );
    }
    return (
      button("page", "К очереди", "jobs") +
      progress +
      integrity +
      card(
        "Лента событий",
        `<div role="log" aria-live="polite"><ol class="event-list">${(j.events || []).map((e) => `<li><time datetime="${esc(e.time)}">${esc(scanTime(e.time))}</time><span>${esc(e.text)}</span></li>`).join("")}</ol></div>`,
      )
    );
  }
  function schedulerView(s) {
    const p = s.schedule,
      form = s.ui.form,
      active = s.tasks.filter((j) => j.state === "running" || j.state === "paused");
    const banner = card(
      "Текущий конвейер",
      active.length
        ? active
            .map(
              (j) =>
                button("pipeTask", esc(j.title) + " · " + num(j.progress) + "%", j.id, "task-link") +
                meter(j.progress, j.title),
            )
            .join("")
        : empty("Сейчас конвейер свободен."),
    );
    return (
      banner +
      card(
        "Расписание",
        `<div class="form-grid">${field("scheduleDays", "Дни", ["Ежедневно", "По будням", "По выходным"], form.scheduleDays || p.days)}${inputField("scheduleStart", "Начало", form.scheduleStart ?? p.start, "time")}${inputField("scheduleEnd", "Окончание", form.scheduleEnd ?? p.end, "time")}</div><div class="file-actions">${button("pipeSchedule", "Сохранить расписание")}${button("pipeAuto", p.enabled ? "Отключить авторежим" : "Включить авторежим", "", "secondary-action", `aria-pressed="${p.enabled}"`)}</div><p class="task-route">Авторежим ${p.enabled ? "включён" : "выключен"} · ${esc(p.days)} · ${esc(p.start)}–${esc(p.end)} · демочасы ${new Date(p.clock).toISOString().slice(11, 16)} UTC</p>`,
      ) +
      scheduler(s)
    );
  }
  function media(s) {
    const form = s.ui.form,
      settings = s.toolSettings;
    const nav = [
      ["index", "Индекс файлов"],
      ["ssd", "Перенос на SSD"],
      ["compress", "Сжатие"],
      ["av1", "AV1"],
      ["settings", "Настройки"],
    ];
    const tab = form.mediaTab || "av1";
    const selector = `<div class="queue-filters">${nav.map(([id, label]) => button("pipeMediaTab", label, id, "secondary-action", `aria-pressed="${tab === id}"`)).join("")}</div>`;
    const configHost = byId(s.hosts, form.configHost) || s.hosts[0];
    const paths = s.toolPaths[configHost?.id] || {};
    if (tab === "settings")
      return (
        selector +
        card(
          "Настройки инструментов",
          field("profile", "Профиль HandBrake", Object.keys(s.encodingProfiles), form.profile || settings.preset) +
            field(
              "algorithm",
              "Алгоритм NTFS",
              ["XPRESS4K", "XPRESS8K", "XPRESS16K", "LZX"],
              form.algorithm || settings.algorithm,
            ) +
            (configHost
              ? field(
                  "configHost",
                  "Хост инструментов",
                  s.hosts.map((h) => [h.id, h.name]),
                  configHost.id,
                ) +
                inputField("encoderPath", "HandBrakeCLI", form.encoderPath ?? paths.encoder ?? "") +
                (configHost.os === "Windows"
                  ? inputField("compactPath", "compact.exe", form.compactPath ?? paths.compact ?? "") +
                    inputField("agentAddress", "Адрес агента", form.agentAddress ?? paths.agent ?? "", "url")
                  : "")
              : empty("Для настройки путей добавьте хост.")) +
            button("pipeSettings", "Сохранить настройки", "", "primary"),
        )
      );
    if (tab === "index") return selector + fileSearch(s);
    if (tab === "ssd" || tab === "compress") {
      const ds = s.disks.filter((d) => (tab === "ssd" ? d.kind === "ssd" : d.fs === "NTFS"));
      const d = byId(ds, form.toolDisk) || ds.find((d) => available(s, d)) || ds[0];
      const files = s.files.filter((f) => f.diskId !== d?.id && available(s, diskOf(s, f))),
        f = byId(files, form.toolFile) || files.find((f) => !copyReason(s, f, d)) || files[0];
      const dirs = Inventory.folders(s, d),
        dir = form.toolDir || dirs[0];
      const reason =
        tab === "ssd"
          ? f
            ? copyReason(s, f, d)
            : "Нет исходных файлов."
          : !available(s, d)
            ? "Нет подключённого диска NTFS."
            : !dir
              ? "Нет каталогов для сжатия."
              : "";
      return (
        selector +
        card(
          tab === "ssd" ? "Перенос на SSD" : "Сжатие NTFS",
          field(
            "toolDisk",
            "Носитель",
            ds.map((d) => [d.id, d.label]),
            d?.id,
          ) +
            (tab === "ssd"
              ? field(
                  "toolFile",
                  "Исходный файл",
                  files.map((f) => [f.id, f.name + " · " + diskOf(s, f).label]),
                  f?.id,
                )
              : field("toolDir", "Каталог", dirs, dir)) +
            `<p class="route-preview">${esc(reason || (tab === "ssd" ? "После копирования останется " + bytes(d.freeBytes - f.sizeBytes) : settings.algorithm))}</p>` +
            button(
              tab === "ssd" ? "pipeSSD" : "pipeCompress",
              tab === "ssd" ? "Начать перенос" : "Сжать каталог",
              tab === "ssd" ? f?.id : d?.id,
              "primary",
              reason ? "disabled" : "",
            ),
        )
      );
    }
    if (!s.demo && s.live && s.live.av1) return selector + av1LiveCard(s);
    const videos = encodeCandidates(s),
      jobs = s.tasks.filter((j) => j.kind === "av1"),
      active = jobs.find((j) => j.state === "running") || jobs[0],
      done = jobs.filter((j) => j.state === "done"),
      saved = done.reduce((n, j) => n + (j.savedBytes || 0), 0);
    const stats = active
      ? card(
          "Обработка AV1",
          `<p>${esc(active.title)} · ${taskLabel(active)}</p>${meter(active.progress, active.title)}<div class="device-volume"><b>${num(active.progress)}%</b><span>${active.state === "running" ? active.operation.fps || s.encodingProfiles[active.operation.preset || s.toolSettings.preset].fps : 0} fps</span><span>ETA ${active.etaSec == null ? "—" : active.etaSec + " с"}</span></div><p>Готово ${done.length} из ${jobs.length} · экономия объёма ${bytes(saved)}</p><small>Освобождено на носителях · ${bytes(s.reclaimedBytes)}</small><div class="file-actions">${button("pipeTask", "Открыть задачу", active.id)}</div>`,
        )
      : empty("Задач AV1 пока нет.");
    return (
      selector +
      card(
        "Перекодирование в AV1",
        (videos.length
          ? field(
              "encodeFile",
              "Видео",
              [["all", "Все доступные видео"], ...videos.map((f) => [f.id, f.name])],
              form.encodeFile || "all",
            )
          : empty("Нет доступных исходных видео.")) +
          button("pipeEncode", "Поставить в очередь", "", "primary", videos.length ? "" : "disabled"),
      ) +
      stats
    );
  }
  function encodeCandidates(s) {
    const seen = new Set();
    return s.files.filter((f) => {
      const derived = "av1:" + f.contentId;
      if (
        f.type !== "Видео" ||
        f.optimized ||
        seen.has(f.contentId) ||
        !available(s, diskOf(s, f)) ||
        s.files.some((c) => c.contentId === derived) ||
        s.tasks.some((j) => ["running", "paused", "error"].includes(j.state) && j.operation?.content === derived)
      )
        return false;
      seen.add(f.contentId);
      return true;
    });
  }
  function confirmed(kind, id) {
    const s = state,
      j = byId(s.tasks, id),
      reason = sourceDeleteReason(s, j);
    if (reason) throw Error(reason);
    const f = byId(s.files, j.operation.fileId),
      d = diskOf(s, f),
      size = f.allocatedBytes ?? f.sizeBytes;
    j.sourcePath = pathOf(s, f);
    j.sourceDeleted = true;
    s.files = s.files.filter((c) => c !== f);
    delete s.manifests[f.id];
    d.freeBytes += size;
    s.reclaimedBytes += size;
    recordEvent(j, "Удаление исходника подтверждено. Освобождено " + bytes(size) + ".");
  }
  function tick(s, seconds) {
    if (s.loading || !s.hosts.length) return;
    s.schedule.clock += seconds * 1000;
    const p = s.schedule,
      date = new Date(p.clock),
      stamp = date.toISOString().slice(0, 10),
      hm = date.toISOString().slice(11, 16);
    const overnight = p.start > p.end,
      day = new Date(p.clock - (overnight && hm < p.end ? 86400000 : 0));
    const dayKey = day.toISOString().slice(0, 10);
    if (!p.enabled || p.lastRun === dayKey || (overnight ? hm >= p.end && hm < p.start : hm < p.start || hm >= p.end))
      return;
    const weekend = [0, 6].includes(day.getUTCDay());
    if ((p.days === "По будням" && weekend) || (p.days === "По выходным" && !weekend)) return;
    const d = s.disks.find((d) => available(s, d) && d.kind !== "optical");
    if (d && enqueue("index", "По расписанию · " + d.label, d.host, d.sizeBytes, { type: "index", target: d.id })) {
      p.lastRun = dayKey;
      recordEvent(s.tasks[0], "Запуск в окне расписания · " + stamp + " " + hm);
    }
  }
  function act(name, id) {
    const s = state,
      form = s.ui.form;
    switch (name) {
      case "pipeTask":
        openJob(id);
        break;
      case "pipeDelete": {
        const j = byId(s.tasks, id),
          reason = sourceDeleteReason(s, j);
        if (reason) throw Error(reason);
        askConfirm(
          "pipeDelete",
          id,
          "Удалить исходный файл?",
          pathOf(s, byId(s.files, j.operation.fileId)) + ". Проверенная копия останется на целевом носителе.",
          "Удалить источник",
        );
        break;
      }
      case "pipeSchedule": {
        const start = form.scheduleStart ?? s.schedule.start,
          end = form.scheduleEnd ?? s.schedule.end;
        if (!start || !end || start === end) throw Error("Укажите разные время начала и окончания.");
        Object.assign(s.schedule, { start, end, days: form.scheduleDays || s.schedule.days });
        message("Расписание сохранено.");
        break;
      }
      case "pipeAuto":
        s.schedule.enabled = !s.schedule.enabled;
        break;
      case "pipeMediaTab":
        s.ui.form = { mediaTab: id };
        break;
      case "pipeSettings": {
        const h = byId(s.hosts, form.configHost) || s.hosts[0],
          paths = s.toolPaths[h?.id] || {};
        if (h) {
          const encoder = (form.encoderPath ?? paths.encoder ?? "").trim(),
            compact = (form.compactPath ?? paths.compact ?? "").trim(),
            agent = (form.agentAddress ?? paths.agent ?? "").trim();
          if (!encoder || (h.os === "Windows" && (!compact || !/^https?:\/\//i.test(agent))))
            throw Error("Укажите путь к кодировщику, а для Windows — адрес агента и путь к compact.exe.");
          s.toolPaths[h.id] = { encoder, compact, agent };
        }
        Object.assign(s.toolSettings, {
          preset: form.profile || s.toolSettings.preset,
          algorithm: form.algorithm || s.toolSettings.algorithm,
        });
        message("Настройки сохранены.");
        break;
      }
      case "pipeCompress": {
        const d = byId(s.disks, id);
        Inventory.compress(d, form.toolDir || Inventory.folders(s, d)[0]);
        break;
      }
      case "pipeSSD": {
        const f = byId(s.files, id),
          d = byId(s.disks, $("toolDisk").value);
        const reason = copyReason(s, f, d);
        if (reason) throw Error(reason);
        if (
          enqueue("copy", "Перенос на SSD · " + f.name, diskOf(s, f).host, f.sizeBytes, {
            type: "copy",
            fileId: f.id,
            target: d.id,
            moveSource: true,
          })
        )
          openJob(s.tasks[0].id);
        break;
      }
      case "pipeEncode": {
        const files = encodeCandidates(s).filter(
          (f) => !form.encodeFile || form.encodeFile === "all" || f.id === form.encodeFile,
        );
        let count = 0;
        for (const f of files) {
          const profile = s.encodingProfiles[s.toolSettings.preset],
            size = Math.round(f.sizeBytes * (1 - profile.saveRatio)),
            d = placement(s.rules["Фильмы"], size);
          if (!d) continue;
          if (
            enqueue("av1", "AV1 · " + f.name, diskOf(s, f).host, f.sizeBytes, {
              type: "encode",
              fileId: f.id,
              content: "av1:" + f.contentId,
              size,
              target: d.id,
              dir: s.rules["Фильмы"].folder + "/",
              preset: s.toolSettings.preset,
              fps: profile.fps,
            })
          )
            count++;
        }
        if (!count) throw Error("Нет доступного назначения или файл уже обрабатывается.");
        message("Поставлено в очередь · " + count);
        break;
      }
    }
  }
  return { taskPage, media, scheduler: schedulerView, tick, act, confirmed };
})();
globalThis.Pipeline = Pipeline;
