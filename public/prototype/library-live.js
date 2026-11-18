"use strict";

// Panel adapter for the designer games screen. Not a copy of another project.
// The working panel (#games without ?demo=1) reads /api/windows-library once.
// It does not start a timer and it does not inspect volumes.

function liveMove(s, g, destination) {
  if (g.running) {
    s.ui.modal = { kind: "winRunning", id: g.id };
    return;
  }
  const file = byId(s.files, g.fileId);
  const expected = file && file.diskId === s.gamePool ? g.archiveId : s.gamePool;
  if (expected !== destination) return;
  const blocked = reasonLive(s, g);
  if (blocked) {
    message(blocked);
    return;
  }
  const toPool = destination === s.gamePool;
  askConfirm(
    "winLiveMove",
    g.id,
    toPool ? "Перенести в «Играю сейчас»?" : "Вернуть игру в архив?",
    g.title + ". Копия проверяется по SHA-256. Источник удаляется только после этой проверки. Игра не должна быть запущена.",
    "Поставить в очередь",
  );
  s.ui.modal.liveDestination = destination;
}

function reasonLive(s, g) {
  const file = byId(s.files, g.fileId);
  const target = byId(s.disks, file && file.diskId === s.gamePool ? g.archiveId : s.gamePool);
  if (!file || !file.diskId) return "У игры нет диска.";
  if (!s.settingsReady && target?.id === s.gamePool) return "Быстрый SSD не выбран в настройках.";
  if (target && target.online === false) return "Диск назначения офлайн.";
  return "";
}

function diskKey(serial, uuid) {
  return "vol-" + String(serial || "disk").replace(/[^a-zA-Z0-9]+/g, "") + "-" + String(uuid || "").slice(0, 8);
}

function launcherLabel(kind) {
  if (kind === "steam") return "Steam";
  if (kind === "epic") return "Epic";
  if (kind === "gog") return "GOG";
  return "Без лаунчера";
}

function compactStatus(game) {
  if (game.job && (game.job.state === "queued" || game.job.state === "running") && game.job.kind === "compress") return "queued";
  if (game.compression === "compressed") return "compressed";
  if (game.compression === "queued") return "queued";
  if (game.compression === "mixed") return "partial";
  return "plain";
}

function applyLibrary(view) {
  const disks = [];
  const ensure = (id, label, online) => {
    if (!disks.some((disk) => disk.id === id)) {
      disks.push({ id, label, mount: "", freeBytes: 1e15, online, host: "pc", kind: id === "ssd" ? "ssd" : "hdd" });
    }
  };
  const ssd = view.settings && view.settings.fastSsd;
  state.settingsReady = Boolean(ssd && ssd.root);
  state.gamePool = "ssd";
  ensure("ssd", state.settingsReady ? "SSD " + ssd.serial : "Быстрый SSD не выбран", state.settingsReady);
  state.files = [];
  state.gameLibrary = (view.games || []).map((game) => {
    const here = game.pool === "playing" ? "ssd" : diskKey(game.serial, game.uuid);
    const archive = diskKey(game.serial, game.uuid);
    if (game.pool !== "playing") ensure(here, game.serial || "Архив", game.online !== false);
    const logical = game.logicalBytes || 0;
    const allocated = game.allocatedBytes == null ? logical : game.allocatedBytes;
    state.files.push({
      id: game.id + "-files",
      name: "",
      dir: game.root,
      diskId: here,
      sizeBytes: logical,
      allocatedBytes: allocated,
      contentId: game.id,
    });
    const saved = logical > 0 ? Math.max(0, Math.round((100 * (logical - allocated)) / logical)) : 0;
    return {
      id: game.id,
      fileId: game.id + "-files",
      title: game.title,
      appId: game.steamAppId || "—",
      launcher: launcherLabel(game.launcher),
      archiveId: archive,
      archivePath: game.root,
      cover: game.cover && game.cover.url ? game.cover.url : "art/gothic.jpg",
      portrait: null,
      algorithm: game.algorithm || "XPRESS8K",
      status: compactStatus(game),
      lastPlayed: null,
      running: false,
      progress: game.job ? game.job.percent : 0,
      community: { percent: saved, samples: 0 },
      history: [],
    };
  });
  state.disks = disks;
  state.hosts = [{ id: "pc", name: "Windows", online: true }];
  state.liveLibrary = true;
  state.loading = false;
}

async function refreshLibrary() {
  const response = await fetch("/api/windows-library", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Библиотека не прочиталась.");
  applyLibrary(payload);
  render(state);
}

async function liveMoveConfirm(modal) {
  const kind = modal.liveDestination === state.gamePool ? "play" : "return";
  state.ui.modal = null;
  const response = await fetch("/api/windows-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: kind, id: modal.id, confirm: true, processes: [] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Задание не поставлено.");
  message("Задание поставлено в очередь. Источник ещё на месте.");
  await refreshLibrary();
}

if (state.liveLibrary) {
  state.gameLibrary = [];
  refreshLibrary().catch((error) => {
    message(error.message);
    render(state);
  });
}
