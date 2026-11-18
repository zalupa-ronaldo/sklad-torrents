"use strict";

async function request(fetchImpl, method, url, body) {
  const response = await fetchImpl(url, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = typeof response.text === "function" ? await response.text() : "";
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "Ответ не JSON." };
    }
  }
  if (!response.ok) throw new Error((data && data.error) || "Панель отклонила запрос.");
  return data;
}

async function settle(fetchImpl, url) {
  try {
    return { ok: true, data: await request(fetchImpl, "GET", url) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Нет ответа." };
  }
}

function form(state) {
  return state.ui?.form || {};
}

const LegacyApi = {
  async loadSurface(fetchImpl) {
    const [games, policies, policyJobs, auto, queues, opticalDvd, opticalCap, opticalCatalog, devices, localFiles, settings, sendJobs, tools, encodePolicy, progress, transfers, link, gameMode] =
      await Promise.all([
        settle(fetchImpl, "/api/games"),
        settle(fetchImpl, "/api/policies"),
        settle(fetchImpl, "/api/policies/jobs"),
        settle(fetchImpl, "/api/scheduler/auto"),
        settle(fetchImpl, "/api/scheduler"),
        settle(fetchImpl, "/api/optical/dvd"),
        settle(fetchImpl, "/api/optical/capabilities"),
        settle(fetchImpl, "/api/optical/catalog"),
        settle(fetchImpl, "/api/localsend/devices"),
        settle(fetchImpl, "/api/localsend/files"),
        settle(fetchImpl, "/api/localsend/settings"),
        settle(fetchImpl, "/api/localsend/jobs"),
        settle(fetchImpl, "/api/tools"),
        settle(fetchImpl, "/api/tools/encode-policy"),
        settle(fetchImpl, "/api/progress"),
        settle(fetchImpl, "/api/torrents/transfers"),
        settle(fetchImpl, "/api/hosts/link"),
        settle(fetchImpl, "/api/game-mode"),
      ]);
    let av1 = { online: false, started: false, lanes: [] };
    try {
      av1 = await request(fetchImpl, "GET", "/api/tools/av1-status");
    } catch (error) {
      av1 = { online: false, started: false, lanes: [], error: error instanceof Error ? error.message : "Агент ПК не в сети." };
    }
    return { games, policies, policyJobs, auto, queues, opticalDvd, opticalCap, opticalCatalog, devices, localFiles, settings, sendJobs, tools, encodePolicy, progress, transfers, link, av1, gameMode };
  },

  async loadFast(fetchImpl) {
    const [jobs, progress] = await Promise.all([settle(fetchImpl, "/api/jobs?limit=100"), settle(fetchImpl, "/api/progress")]);
    return { jobs, progress };
  },

  async jobControl(fetchImpl, id, action) {
    const paths = {
      pause: `/api/jobs/${encodeURIComponent(id)}/pause`,
      resume: `/api/jobs/${encodeURIComponent(id)}/resume`,
      cancel: `/api/jobs/${encodeURIComponent(id)}/cancel`,
      retry: `/api/jobs/${encodeURIComponent(id)}/retry`,
    };
    await request(fetchImpl, "POST", paths[action] || paths.pause);
  },

  listenJobs(onEvent) {
    if (typeof EventSource === "undefined") return { close() {} };
    const source = new EventSource("/api/jobs/events");
    source.onmessage = () => onEvent();
    return source;
  },

  listenGameMode(onEvent) {
    if (typeof EventSource === "undefined") return { close() {} };
    const source = new EventSource("/api/game-mode/events");
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        onEvent(null);
      }
    };
    return source;
  },

  downloadFile(diskId, filePath) {
    const url = `/api/files/download?diskId=${encodeURIComponent(diskId)}&path=${encodeURIComponent(filePath)}`;
    if (typeof document === "undefined") return url;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    return url;
  },

  actions: {
    async gameMode(fetchImpl, state) {
      const mode = state.ui?.form?.gameMode || state.ui?.pending;
      const value = typeof mode === "string" ? mode : "auto";
      const data = await request(fetchImpl, "POST", "/api/game-mode", { mode: value === "on" || value === "off" || value === "auto" ? value : "auto" });
      state.gameMode = data;
      return { message: data.active ? "Игровой режим: фон на паузе." : "Фон снова работает." };
    },
    async hostTest(fetchImpl, state) {
      const values = form(state);
      await request(fetchImpl, "POST", "/api/hosts/test", {
        id: values.hostId || undefined,
        baseUrl: values.baseUrl || "",
        username: values.username || "",
        password: values.password || "",
      });
      return { message: "Связь с qBittorrent проверена.", refresh: false };
    },
    async hostSave(fetchImpl, state) {
      const values = form(state);
      const payload = {
        name: values.name || "",
        baseUrl: values.baseUrl || "",
        username: values.username || "",
        password: values.password || "",
        os: values.os || "darwin",
        pathPresets: [],
      };
      if (values.hostId) await request(fetchImpl, "PATCH", `/api/hosts/${encodeURIComponent(values.hostId)}`, payload);
      else await request(fetchImpl, "POST", "/api/hosts", payload);
      return { message: values.hostId ? "Хост обновлён." : "Хост добавлен.", refresh: true };
    },
    async hostReset(fetchImpl, state) {
      const id = form(state).hostId;
      if (!id) throw new Error("Не выбран хост.");
      await request(fetchImpl, "POST", `/api/hosts/${encodeURIComponent(id)}/reset`, {});
      return { message: "Демо-хост сброшен.", refresh: true };
    },
    async hostDelete(fetchImpl, state) {
      const id = form(state).hostId;
      if (!id) throw new Error("Не выбран хост.");
      await request(fetchImpl, "DELETE", `/api/hosts/${encodeURIComponent(id)}`);
      return { message: "Хост удалён.", refresh: true };
    },
    async rescan(fetchImpl) {
      await request(fetchImpl, "POST", "/api/drives/rescan", {});
      return { message: "Полка перечитывает агентов.", refresh: true };
    },
    async compact(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/drives/compact", {
        diskId: form(state).diskId || state.ui.disk || "",
        path: form(state).path || form(state).compressDir || "",
        algorithm: form(state).algorithm || "xpress16k",
        confirm: true,
      });
      return { message: "Сжатие поставлено в очередь.", refresh: true };
    },
    async download(fetchImpl, state) {
      const file = (state.files || []).find((item) => item.id === state.ui.fileId) || (state.files || [])[0];
      if (!file?.diskId || !file.path) throw new Error("Нет файла для скачивания.");
      LegacyApi.downloadFile(file.diskId, file.path);
      return { message: "Скачивание открыто.", refresh: false };
    },
    async copyPoll(fetchImpl, state) {
      const id = form(state).copyId;
      if (!id) throw new Error("Нет идентификатора копирования.");
      await request(fetchImpl, "GET", `/api/files/copy/${encodeURIComponent(id)}`);
      return { message: "Состояние копирования обновлено.", refresh: true };
    },
    async renameDisk(fetchImpl, state) {
      const id = form(state).diskId;
      if (!id) throw new Error("Не выбран диск.");
      await request(fetchImpl, "PATCH", `/api/drives/${encodeURIComponent(id)}`, { label: form(state).label || "" });
      return { message: "Имя диска записано.", refresh: true };
    },
    async torrentDelete(fetchImpl, state) {
      const torrent = (state.torrents || []).find((item) => item.id === form(state).torrentId);
      if (!torrent?.hostId) throw new Error("У раздачи нет хоста.");
      await request(fetchImpl, "POST", `/api/torrents/${encodeURIComponent(torrent.hostId)}/${encodeURIComponent(torrent.id)}`, {
        action: "delete",
        deleteFiles: form(state).deleteFiles === "1",
      });
      return { message: "Раздача удалена.", refresh: true };
    },
    async torrentHashes(fetchImpl, state) {
      const torrent = (state.torrents || []).find((item) => item.id === form(state).torrentId);
      if (!torrent?.hostId) throw new Error("У раздачи нет хоста.");
      const url = `/api/torrents/${encodeURIComponent(torrent.hostId)}/${encodeURIComponent(torrent.id)}/hashes`;
      await request(fetchImpl, form(state).hashWrite === "1" ? "POST" : "GET", url, form(state).hashWrite === "1" ? {} : undefined);
      return { message: "Хеши раздачи запрошены.", refresh: true };
    },
    async torrentPlacement(fetchImpl, state) {
      const torrent = (state.torrents || []).find((item) => item.id === form(state).torrentId);
      if (!torrent?.hostId) throw new Error("У раздачи нет хоста.");
      await request(fetchImpl, "GET", `/api/torrents/${encodeURIComponent(torrent.hostId)}/${encodeURIComponent(torrent.id)}/placement`);
      return { message: "Раскладка раздачи прочитана.", refresh: false };
    },
    async torrentOverride(fetchImpl, state) {
      const torrent = (state.torrents || []).find((item) => item.id === form(state).torrentId);
      if (!torrent?.hostId) throw new Error("У раздачи нет хоста.");
      await request(fetchImpl, "POST", "/api/overrides", { hostId: torrent.hostId, hash: torrent.id, kind: form(state).kind || "video" });
      return { message: "Переопределение записано.", refresh: true };
    },
    async torrentTransfer(fetchImpl, state) {
      const torrent = (state.torrents || []).find((item) => item.id === form(state).torrentId) || state.torrents?.[0];
      if (!torrent?.hostId) throw new Error("У раздачи нет хоста.");
      await request(fetchImpl, "POST", "/api/torrents/transfers", {
        hostId: torrent.hostId,
        hash: torrent.id,
        destination: form(state).destination || "",
      });
      return { message: "Перенос раздачи поставлен в очередь.", refresh: true };
    },
    async transferControl(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/torrents/transfers/control", { action: form(state).transferAction || "pause", id: form(state).transferId || "" });
      return { message: "Очередь переносов обновлена.", refresh: true };
    },
    async transferPolicy(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/torrents/transfers/policy", { maxParallel: Number(form(state).maxParallel || 1) });
      return { message: "Политика переноса записана.", refresh: true };
    },
    async supervisor(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/torrents/supervisor", { hostId: form(state).hostId || "", action: form(state).supervisorAction || "tick" });
      return { message: "Наблюдатель qBittorrent опрошен.", refresh: false };
    },
    async progressAction(fetchImpl, state) {
      const id = form(state).progressId;
      if (!id) throw new Error("Не выбрана операция.");
      await request(fetchImpl, "POST", `/api/progress/${encodeURIComponent(id)}`, { action: form(state).progressAction || "pause" });
      return { message: "Операция обновлена.", refresh: true };
    },
    async progressLink(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/progress/link", state.live?.link?.data || {});
      return { message: "Канал записан.", refresh: true };
    },
    async progressQueue(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/progress/queue", { action: form(state).queueAction || "pause" });
      return { message: "Очередь прогресса обновлена.", refresh: true };
    },
    async progressLoad(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/progress/load", { paused: form(state).loadPaused === "1" });
      return { message: "Нагрузка записана.", refresh: true };
    },
    async integrityGet(fetchImpl, state) {
      const id = form(state).integrityId;
      if (!id) throw new Error("Нет проверки.");
      await request(fetchImpl, "GET", `/api/integrity/${encodeURIComponent(id)}`);
      return { message: "Проверка прочитана.", refresh: false };
    },
    async integrityCancel(fetchImpl, state) {
      const id = form(state).integrityId;
      if (!id) throw new Error("Нет проверки.");
      await request(fetchImpl, "POST", `/api/integrity/${encodeURIComponent(id)}/cancel`, {});
      return { message: "Проверка отменена.", refresh: true };
    },
    async integrityConfirm(fetchImpl, state) {
      const id = form(state).integrityId;
      if (!id) throw new Error("Нет проверки.");
      await request(fetchImpl, "POST", `/api/integrity/${encodeURIComponent(id)}/confirm`, { deleteSource: form(state).deleteSource === "1" });
      return { message: "Проверка подтверждена.", refresh: true };
    },
    async confirmSourceDelete(fetchImpl, state) {
      const id = form(state).jobId;
      if (!id) throw new Error("Не выбрана задача.");
      await request(fetchImpl, "POST", `/api/jobs/${encodeURIComponent(id)}/confirm-source-delete`, {});
      return { message: "Удаление источника подтверждено.", refresh: true };
    },
    async jobEnqueue(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/jobs", {
        kind: form(state).jobKind || "copy",
        host: form(state).jobHost || "mac-local",
        source: form(state).sourcePath || "",
        destination: form(state).destination || "",
      });
      return { message: "Задача поставлена в очередь.", refresh: true };
    },
    async schedulerAct(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/scheduler", {
        action: form(state).schedulerAction || "next",
        diskKey: form(state).diskKey || "",
        torrentKey: form(state).torrentKey || "",
        hostId: form(state).hostId || "",
        hash: form(state).hash || "",
      });
      return { message: "Планировщик обновлён.", refresh: true };
    },
    async localsendAdd(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/localsend/devices", { fingerprint: form(state).fingerprint || "", alias: form(state).alias || "" });
      return { message: "Устройство LocalSend записано.", refresh: true };
    },
    async localsendSend(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/localsend/send", {
        fingerprint: form(state).fingerprint || "",
        paths: form(state).sourcePath ? [form(state).sourcePath] : [],
      });
      return { message: "Отправка поставлена в очередь.", refresh: true };
    },
    async localsendSettings(fetchImpl, state) {
      await request(fetchImpl, "PUT", "/api/localsend/settings", { alias: form(state).alias || "" });
      return { message: "Настройки LocalSend записаны.", refresh: true };
    },
    async opticalJob(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/optical/dvd/jobs", { name: form(state).name || "", paths: form(state).sourcePath ? [form(state).sourcePath] : [] });
      return { message: "Запись диска поставлена в очередь.", refresh: true };
    },
    async opticalControl(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/optical/control", { action: form(state).opticalAction || "eject" });
      return { message: "Команда приводу отправлена.", refresh: true };
    },
    async opticalDemo(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/optical/dvd", { demo: form(state).opticalDemo === "1" });
      return { message: "Режим оптики записан.", refresh: true };
    },
    async opticalImage(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/optical/disc-image", { name: form(state).name || "", source: form(state).sourcePath || "" });
      return { message: "Образ поставлен в очередь.", refresh: true };
    },
    async policyPreset(fetchImpl, state) {
      await request(fetchImpl, "PUT", "/api/policies", { presetId: form(state).presetId || "custom" });
      return { message: "Правила записаны.", refresh: true };
    },
    async policyPreview(fetchImpl) {
      await request(fetchImpl, "POST", "/api/policies/preview", {});
      return { message: "Пробный прогон выполнен.", refresh: true };
    },
    async policyAuto(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/policies/automation", { enabled: form(state).automation === "1" });
      return { message: "Автоматика правил обновлена.", refresh: true };
    },
    async policyApply(fetchImpl) {
      await request(fetchImpl, "POST", "/api/policies/apply", {});
      return { message: "Правила поставлены в очередь.", refresh: true };
    },
    async policyConfirm(fetchImpl, state) {
      const id = form(state).policyJobId;
      if (!id) throw new Error("Не выбрана задача правила.");
      await request(fetchImpl, "POST", `/api/policies/jobs/${encodeURIComponent(id)}`, { confirm: true });
      return { message: "Задача правила подтверждена.", refresh: true };
    },
    async gameAct(fetchImpl, state) {
      await request(fetchImpl, "POST", "/api/games", { action: form(state).gameAction || "launch", id: form(state).gameId || "" });
      return { message: "Игровая полка обновлена.", refresh: true };
    },
    async mediaIndex(fetchImpl) {
      await request(fetchImpl, "POST", "/api/media/index", {});
      return { message: "Индекс медиа поставлен в очередь.", refresh: true };
    },
    async mediaSearch(fetchImpl, state) {
      const query = state.ui.fileQuery || form(state).query || "";
      await request(fetchImpl, "GET", `/api/media/search?q=${encodeURIComponent(query)}`);
      return { message: "Поиск по индексу выполнен.", refresh: false };
    },
    async toolJob(fetchImpl, state) {
      const kind = form(state).toolKind || "compress";
      await request(fetchImpl, "POST", "/api/tools/jobs", {
        kind,
        hostId: form(state).hostId || "pc",
        folderPath: form(state).folderPath || "",
        algorithm: form(state).algorithm || "LZX",
        name: form(state).name || "",
        sourcePath: form(state).sourcePath || "",
        destinationPath: form(state).destination || "",
        inputPath: form(state).sourcePath || "",
        outputPath: form(state).destination || "",
        presetId: form(state).presetId || "",
        replaceOriginal: form(state).replaceOriginal === "1",
      });
      return { message: "Инструмент поставлен в очередь.", refresh: true };
    },
    async toolAction(fetchImpl, state) {
      const id = form(state).toolJobId;
      if (!id) throw new Error("Не выбрана задача инструмента.");
      await request(fetchImpl, "POST", `/api/tools/jobs/${encodeURIComponent(id)}`, { action: form(state).toolAction || "pause" });
      return { message: "Задача инструмента обновлена.", refresh: true };
    },
    async toolConfig(fetchImpl, state) {
      await request(fetchImpl, "PUT", "/api/tools/config", { hosts: form(state).hostsJson ? JSON.parse(form(state).hostsJson) : [] });
      return { message: "Настройки инструментов записаны.", refresh: true };
    },
    async encodePolicy(fetchImpl, state) {
      await request(fetchImpl, "PUT", "/api/tools/encode-policy", { replaceOriginal: form(state).replaceOriginal === "1" });
      return { message: "Политика кодирования записана.", refresh: true };
    },
  },
};

globalThis.LegacyApi = LegacyApi;
