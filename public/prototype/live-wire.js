"use strict";

const NAV = new Set([
  "page",
  "menu",
  "closeMenu",
  "navMore",
  "close",
  "family",
  "more",
  "disk",
  "file",
  "backToFiles",
  "status",
  "taskKind",
  "platform",
  "dest",
  "find",
  "quickCopy",
  "host",
  "clearShelf",
  "resetTorrents",
  "torrent",
  "fileOp",
  "add",
  "pipeTask",
  "pipeMediaTab",
  "shopRule",
]);

function blankUi() {
  return {
    page: "overview",
    menu: false,
    navMore: false,
    taskId: null,
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
    category: "",
    form: {},
  };
}

function shell() {
  return {
    hosts: [],
    disks: [],
    files: [],
    torrents: [],
    tasks: [],
    history: [],
    rules: {},
    manifests: {},
    checksums: {},
    comparisons: [],
    devices: [],
    loading: true,
    demo: false,
    error: null,
    automation: false,
    previewFresh: false,
    gamePool: null,
    imageDisk: null,
    demoTransferRate: null,
    toolSettings: { preset: "", algorithm: "" },
    encodingProfiles: {},
    toolPaths: {},
    sendSettings: { discovery: false, alias: "", port: "" },
    reclaimedBytes: null,
    schedule: { enabled: false, days: "", start: "", end: "", clock: Date.now() },
    failNext: {},
    live: { av1: { online: false, started: false, lanes: [] } },
    scenario: "live",
    scenarioOptions: [],
    ui: blankUi(),
  };
}

const LiveWire = {
  placeholder: shell,
  async refresh(current) {
    const [snapshot, live] = await Promise.all([
      PanelAdapter.loadPanel({ fetchImpl: fetch, timeoutMs: 8000 }),
      LegacyApi.loadSurface(fetch),
    ]);
    const keepFiles = Boolean(current.ui.fileQuery || current.ui.disk || current.ui.page === "move" || current.ui.page === "details");
    return {
      ...shell(),
      ...snapshot,
      ui: current.ui,
      files: keepFiles ? current.files : snapshot.files,
      demo: false,
      live,
      shelfGames: LivePoll.flattenShelfGames(live.games?.ok ? live.games.data : null),
      loading: false,
    };
  },
  async refreshFast(current) {
    const fast = await LegacyApi.loadFast(fetch);
    const next = { ...current, loading: false };
    if (fast.jobs?.ok && Array.isArray(fast.jobs.data?.jobs)) {
      const mapped = fast.jobs.data.jobs.map((job) => PanelAdapter.mapQueueJob(job)).filter(Boolean);
      const rest = (current.tasks || []).filter((task) => task.source !== "queue");
      next.tasks = [...rest, ...mapped];
    }
    if (fast.progress?.ok) next.live = { ...(current.live || {}), progress: fast.progress.data };
    return next;
  },
  async handle(name, value, state) {
    if (name === "confirmAction") {
      const modal = state.ui.modal;
      if (!modal || modal.kind !== "confirm") return { stop: true, message: "Нет подтверждения." };
      const action = modal.action;
      const id = modal.id;
      state.ui.modal = null;
      return perform(action, id, state);
    }
    const spec = LivePoll.confirmSpec(name, state.ui?.page);
    if (spec) {
      state.ui.modal = { kind: "confirm", action: name, id: value ?? "", title: spec.title, description: spec.description, label: spec.label };
      return { stop: true };
    }
    return perform(name, value, state);
  },
};

async function perform(name, value, state) {
    if (NAV.has(name)) return { stop: false };
    const form = state.ui.form;
    try {
      if (name === "invFolder") {
        state.ui.form.diskId = value || state.ui.disk;
        state.ui.modal = { kind: "compactDisk", id: value || state.ui.disk };
        return { stop: true };
      }
      if (name === "compactDisk" || name === "invCompress") {
        form.diskId = value || form.diskId || state.ui.disk;
        form.path = form.compressPath || form.compressDir || "";
        form.algorithm = form.algorithm || "xpress16k";
        state.ui.modal = null;
        return { stop: true, ...(await LegacyApi.actions.compact(fetch, state)) };
      }
      if (name === "renameDisk") {
        state.ui.form.diskId = value;
        state.ui.modal = { kind: "renameDisk", id: value };
        return { stop: true };
      }
      if (name === "renameDiskSave") {
        form.diskId = state.ui.modal?.id || form.diskId;
        form.label = form.diskLabel || form.label || "";
        state.ui.modal = null;
        return { stop: true, ...(await LegacyApi.actions.renameDisk(fetch, state)) };
      }
      if (name === "game") {
        form.gameId = value;
        form.gameAction = "launch";
        return { stop: true, ...(await LegacyApi.actions.gameAct(fetch, state)) };
      }
      if (name === "reindex") {
        form.diskId = value || state.ui.disk;
        return { stop: true, ...(await LegacyApi.actions.rescan(fetch, state)) };
      }
      if (name === "invDownload" || name === "download") {
        state.ui.fileId = value || state.ui.fileId;
        return { stop: true, ...(await LegacyApi.actions.download(fetch, state)) };
      }
      if (name === "invProbe") {
        form.hostId = value;
        return { stop: true, ...(await LegacyApi.actions.hostTest(fetch, state)) };
      }
      if (name === "invSaveHost") {
        form.name = form.hostName || form.name;
        form.baseUrl = form.hostAddress || form.baseUrl;
        form.os = form.hostOS === "macOS" ? "darwin" : "win32";
        form.hostId = value || form.hostId;
        return { stop: true, ...(await LegacyApi.actions.hostSave(fetch, state)) };
      }
      if (name === "invReset") {
        form.hostId = value;
        return { stop: true, ...(await LegacyApi.actions.hostReset(fetch, state)) };
      }
      if (name === "invRemove") {
        form.hostId = value;
        return { stop: true, ...(await LegacyApi.actions.hostDelete(fetch, state)) };
      }
      if (name === "invHashes") {
        form.torrentId = value;
        return { stop: true, ...(await LegacyApi.actions.torrentHashes(fetch, state)) };
      }
      if (name === "invRemoveTorrent") {
        form.torrentId = value;
        return { stop: true, ...(await LegacyApi.actions.torrentDelete(fetch, state)) };
      }
      if (name === "invMigrate" || name === "torrentTransfer") {
        form.torrentId = value || form.torrentId;
        return { stop: true, ...(await LegacyApi.actions.torrentTransfer(fetch, state)) };
      }
      if (name === "pipeEncode") return { stop: true, message: "Кодирование с панели не запускается. Ход AV1 только читается." };
      if (name === "pipeCompress") {
        form.toolKind = "compress";
        form.diskId = value;
        return { stop: true, ...(await LegacyApi.actions.toolJob(fetch, state)) };
      }
      if (name === "pipeSSD") {
        form.toolKind = "move";
        return { stop: true, ...(await LegacyApi.actions.toolJob(fetch, state)) };
      }
      if (name === "pipeDelete") {
        form.jobId = value;
        return { stop: true, ...(await LegacyApi.actions.confirmSourceDelete(fetch, state)) };
      }
      if (name === "pipeSchedule" || name === "pipeAuto") return { stop: true, ...(await LegacyApi.actions.schedulerAct(fetch, state)) };
      if (name === "shopApply") return { stop: true, ...(await LegacyApi.actions.policyApply(fetch, state)) };
      if (name === "shopTray" || name === "shopBlank") {
        form.opticalAction = name === "shopTray" ? "tray" : "blank";
        return { stop: true, ...(await LegacyApi.actions.opticalControl(fetch, state)) };
      }
      if (name === "shopDiscover") return { stop: true, refresh: true };
      if (name === "pause" || name === "cancel" || name === "retry") {
        const task = (state.tasks || []).find((item) => item.id === value);
        if (task?.source === "queue") {
          const action = name === "pause" && task.state === "paused" ? "resume" : name;
          await LegacyApi.jobControl(fetch, task.id, action);
          return { stop: true, message: "Задача обновлена.", refresh: true };
        }
        if (task?.progressId) {
          form.progressId = task.progressId;
          form.progressAction = name === "pause" && task.state === "paused" ? "resume" : name;
          return { stop: true, ...(await LegacyApi.actions.progressAction(fetch, state)) };
        }
        return { stop: true, message: "У этой задачи нет команды на панели." };
      }
      if (name === "run" && state.ui.page === "optical") return { stop: true, ...(await LegacyApi.actions.opticalJob(fetch, state)) };
      if (name === "run") return { stop: true, ...(await LegacyApi.actions.jobEnqueue(fetch, state)) };
      if (LegacyApi.actions[name]) return { stop: true, ...(await LegacyApi.actions[name](fetch, state)) };
      return { stop: true, message: "Это действие в живой панели не меняет компьютер." };
    } catch (error) {
      return { stop: true, message: error instanceof Error ? error.message : "Панель отклонила запрос." };
    }
}

globalThis.LiveWire = LiveWire;
