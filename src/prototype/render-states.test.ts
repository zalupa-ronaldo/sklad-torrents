import { readFileSync } from "node:fs";
import path from "node:path";
import { Script, createContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { assemble, loadingSnapshot, mapCopyJob } from "../../public/prototype/panel-adapter.js";

function workbench() {
  const code = readFileSync(path.join(process.cwd(), "public/prototype/workbench.js"), "utf8");
  const sandbox: { SkladWorkbench?: { screen: (state: Record<string, unknown>) => string; sidebar: (state: Record<string, unknown>) => string } } = {};
  createContext(sandbox);
  new Script(code).runInContext(sandbox);
  if (!sandbox.SkladWorkbench) throw new Error("workbench did not export");
  return sandbox.SkladWorkbench;
}

function ui(page = "overview") {
  return {
    page,
    menu: false,
    modal: null,
    notice: "",
    query: "",
    family: "",
    connection: "all",
    limit: 20,
    fileQuery: "",
    disk: "",
    host: "",
    status: "",
    torrentQuery: "",
    period: "60",
    sample: null,
    platform: "Все",
    category: "",
    form: {},
  };
}

function paint(snapshot: Record<string, unknown>, page = "overview") {
  const view = workbench();
  const state = { ...snapshot, ui: ui(page) };
  return { screen: view.screen(state), sidebar: view.sidebar(state) };
}

describe("collection screens", () => {
  const view = workbench();

  it("renders loading, empty, host offline, disk offline, copy, and error", () => {
    const loading = paint({ ...loadingSnapshot(), demo: false });
    expect(loading.screen).toContain("Загрузка коллекции");
    expect(loading.screen).toContain("Загрузка очереди");
    expect(loading.screen).not.toContain("Демосостояние");

    const empty = paint(assemble({ drives: { disks: [], agentErrors: [] }, copies: { jobs: [] }, jobs: { jobs: [] }, torrents: { hosts: [], torrents: [] }, destinations: { destinations: [] }, channel: null, channelMissing: true }));
    expect(empty.screen).toContain("Носителей пока нет");
    expect(empty.screen).toContain("В очереди нет задач");
    expect(empty.screen).toContain("Нет данных о скорости");

    const offlineHost = paint(
      assemble({
        drives: {
          disks: [{ id: "disk-a", label: "Archive", filesystem: "NTFS", totalBytes: 10, freeBytes: 1, online: true, lastSeenAt: "2026-11-01T00:00:00Z", lastHostId: "mac-mini", lastHostName: "Mac mini", mountPaths: ["/Volumes/Archive"], lastMountPath: "/Volumes/Archive", fileCount: 1 }],
          agentErrors: [{ hostId: "mac-mini", hostName: "Mac mini", message: "агент 4371 не ответил" }],
        },
        copies: { jobs: [] },
        jobs: { jobs: [] },
        torrents: { hosts: [], torrents: [] },
        destinations: { destinations: [] },
        channel: null,
        channelMissing: true,
      }),
    );
    expect(offlineHost.sidebar).toContain("Нет связи");
    expect(offlineHost.sidebar).toContain("Mac mini");
    expect(offlineHost.screen).toContain("Не в сети");

    const offlineDisk = paint(
      assemble({
        drives: {
          disks: [{ id: "disk-b", label: "Shelf", filesystem: "NTFS", totalBytes: 10, freeBytes: 1, online: false, lastSeenAt: "2026-11-02T00:00:00Z", lastHostId: "windows-pc", lastHostName: "Windows PC", mountPaths: [], lastMountPath: "E:\\", fileCount: 0 }],
          agentErrors: [],
        },
        copies: { jobs: [] },
        jobs: { jobs: [] },
        torrents: { hosts: [], torrents: [] },
        destinations: { destinations: [] },
        channel: { peers: { "pc-agent": { detail: null } } },
      }),
    );
    expect(offlineDisk.sidebar).toContain("В сети");
    expect(offlineDisk.screen).toContain("Не в сети");
    expect(offlineDisk.screen).toContain("Shelf");
    expect(offlineDisk.screen).toContain("Тип носителя не сообщается");

    const copying = mapCopyJob({ id: "c1", status: "running", title: "Копирование · notes.txt", bytesDone: 25, bytesTotal: 100, speed: 5, sourceSha256: "deadbeef", verified: false, error: null });
    const withCopy = paint(
      {
        ...assemble({ drives: { disks: [], agentErrors: [] }, copies: { jobs: [] }, jobs: { jobs: [] }, torrents: { hosts: [], torrents: [] }, destinations: { destinations: [] }, channel: null, channelMissing: true }),
        tasks: [copying],
      },
      "jobs",
    );
    expect(withCopy.screen).toContain("Копирование · notes.txt");
    expect(withCopy.screen).toContain("Выполняется");
    expect(withCopy.screen).toContain("SHA-256");
    expect(withCopy.screen).toContain("deadbeef");

    const failed = paint(
      {
        ...assemble({ drives: { disks: [], agentErrors: [] }, copies: { jobs: [] }, jobs: { jobs: [] }, torrents: { hosts: [], torrents: [] }, destinations: { destinations: [] }, channel: null, channelMissing: true }),
        tasks: [mapCopyJob({ id: "e1", status: "error", title: "Копирование · film.mkv", bytesDone: 1, bytesTotal: 10, speed: 0, error: "Диск назначения отключился" })],
      },
      "jobs",
    );
    expect(failed.screen).toContain("Ошибка");
    expect(failed.screen).toContain("Диск назначения отключился");
    expect(view.screen({ ...loadingSnapshot(), ui: ui("torrents") })).toContain("Загрузка раздела");
  });

  it("renders the torrent, catalog, and job screens from a live snapshot", () => {
    const snapshot = assemble({
      drives: {
        disks: [{ id: "disk-1", label: "Vault", filesystem: "APFS", totalBytes: 100, freeBytes: 40, online: true, lastSeenAt: "2026-11-18T00:00:00Z", lastHostId: "mac-mini", lastHostName: "Mac mini", mountPaths: ["/Volumes/vault"], lastMountPath: "/Volumes/vault", fileCount: 2 }],
        agentErrors: [],
      },
      copies: { jobs: [] },
      jobs: { jobs: [{ id: "job-9", kind: "index", host: "mac-local", state: "done", lastError: null, progress: { percent: 100, speed: 0, etaSeconds: 0, totalBytes: 10, processedBytes: 10, currentFile: "" } }] },
      torrents: {
        hosts: [{ id: "qb-mac", name: "Mac mini", online: true }],
        torrents: [{ hash: "abc", name: "Debian netinst", state: "seeding", progress: 1, totalSize: 400, dlspeed: 0, upspeed: 1_000_000, savePath: "/Volumes/vault/ISO", hostId: "qb-mac", hostName: "Mac mini", category: "" }],
      },
      destinations: { destinations: [{ id: "mac-downloads", label: "Загрузки", online: true, freeBytes: 0 }] },
      channel: { peers: { "pc-agent": { detail: null } } },
    });
    const torrents = paint(snapshot, "torrents");
    expect(torrents.screen).toContain("Debian netinst");
    expect(torrents.screen).toContain("Раздача");
    expect(torrents.screen).toContain("Mac mini");
    const files = paint({ ...snapshot, files: [] }, "drives");
    expect(files.screen).toContain("Введите имя файла");
    const jobs = paint(snapshot, "jobs");
    expect(jobs.screen).toContain("index");
    expect(jobs.screen).toContain("Готово");
    const legacy = paint(snapshot, "overview");
    expect(legacy.sidebar).toContain('href="/legacy"');
    expect(legacy.sidebar).not.toContain("Деморежим");
  });
});
