"use strict";

// The provider boundary is a plain snapshot. Each scenario returns independent records.
const DemoData = (() => {
  const GB = 1e9;
  const scenarios = [
    ["normal", "Норма"],
    ["offline", "ПК офлайн"],
    ["copying", "Идёт копирование"],
    ["error", "Ошибка"],
    ["empty", "Пусто"],
    ["loading", "Загрузка"],
  ];
  const hosts = [
    { id: "mac", name: "Mac mini", online: true },
    { id: "pc", name: "Windows PC", online: true },
  ];

  function carrier(id, label, kind, host, capacity, free, mount, fs, location, lastSeen = "2026-11-18T14:30:00Z") {
    return {
      id,
      label,
      kind,
      host,
      sizeBytes: capacity * GB,
      freeBytes: free * GB,
      online: Boolean(mount),
      lastSeen,
      mount,
      fs,
      location,
    };
  }
  const disks = [
    carrier("archive", "Archive HDD", "hdd", "pc", 8000, 3620, "D:/", "NTFS", "Холодный архив"),
    carrier("pool", "Game SSD", "ssd", "pc", 1000, 292, "C:/", "NTFS", "Игровой пул"),
    carrier("usb", "Флешка 01", "usb", "mac", 64, 31, "/Volumes/Flash/", "exFAT", "Рабочий стол"),
    carrier("camera", "Камера SD", "sd", "mac", 128, 74, "/Volumes/Camera/", "exFAT", "Картридер"),
    carrier("dvd", "DVD-R 07", "optical", "pc", 4.7, 0.5, null, "UDF", "Альбом · карман 7", "2026-11-04T15:00:00Z"),
    carrier("backup", "Архив 02", "hdd", "pc", 4000, 900, null, "NTFS", "Стеллаж A · ячейка 2", "2026-11-12T12:00:00Z"),
    carrier("media", "Media HDD", "hdd", "pc", 4000, 1590, "S:/", "NTFS", "Медиатека"),
    carrier("vault", "Vault SSD", "ssd", "mac", 2000, 778, "/Volumes/vault/", "APFS", "Временная обработка"),
    carrier("data", "Data SSD", "ssd", "mac", 1000, 293, "/System/Volumes/Data/", "APFS", "Встроенный диск"),
    carrier("cold", "Архив 03", "hdd", "pc", 6000, 2100, null, "NTFS", "Стеллаж A · ячейка 3", "2026-10-28T12:00:00Z"),
    carrier(
      "cd",
      "Концерт CD",
      "optical",
      "mac",
      0.734,
      0.19,
      null,
      "ISO 9660",
      "Альбом · карман 4",
      "2026-11-05T12:00:00Z",
    ),
    carrier("sd2", "Камера B", "sd", "mac", 64, 20, null, "exFAT", "Органайзер · слот 2", "2026-11-08T12:00:00Z"),
  ];
  function file(id, name, diskId, dir, type, size, extra = {}) {
    return { id, name, diskId, dir, type, sizeBytes: Math.round(size * GB), contentId: id, ...extra };
  }
  const files = [
    file("hades", "Hades", "archive", "Games/", "Игра", 11.1, { platform: "Windows", expectedSaving: 0.24 }),
    file("gothic", "Gothic II", "archive", "Games/", "Игра", 3.6, { platform: "Windows" }),
    file("zelda", "Breath of the Wild", "archive", "Switch/", "Игра", 14.4, { platform: "Switch" }),
    file("gow", "Chains of Olympus", "archive", "PSP/", "Игра", 1.5, { platform: "PSP" }),
    file("hollow", "Hollow Knight.app", "data", "Games/", "Игра", 7.8, { platform: "macOS" }),
    file("film", "Sintel.mkv", "media", "Movies/", "Видео", 3.5),
    file("trailer", "Spring.mkv", "vault", "Movies/", "Видео", 1.1),
    file("osm", "OpenStreetMap · Europe", "archive", "Maps/", "Данные", 31.6, { torrentId: "osm" }),
    file("blend", "Blender Demo Files", "vault", "Downloads/", "Архив", 8.4, { torrentId: "blend" }),
    file("debian", "Debian 13 · netinst", "media", "ISO/", "Образ", 0.784, { torrentId: "debian" }),
    file("audio", "Концерт.flac", "cd", "Audio/", "Музыка", 0.48),
    file("book", "Каталог.pdf", "camera", "Documents/", "Документ", 0.024),
  ];
  for (const [source, targets] of [
    ["film", ["backup", "usb", "dvd"]],
    ["hades", ["cold"]],
    ["trailer", ["sd2"]],
  ]) {
    for (const target of targets)
      files.push({ ...files.find((f) => f.id === source), id: source + "-" + target, diskId: target });
  }
  const torrentRows = [
    ["ubuntu", "Ubuntu 24.04.2 Desktop", "image", "vault", "down", 68, 5.9, 28.4, 0],
    ["bunny", "Big Buck Bunny · 4K", "video", "archive", "down", 42, 3.2, 20.2, 0],
    ["osm", "OpenStreetMap · Europe", "data", "archive", "seed", 100, 31.6, 0, 8.6],
    ["blend", "Blender Demo Files", "archive", "vault", "seed", 100, 8.4, 0, 4.2],
    ["music", "Musopen Collection", "audio", "data", "pause", 36, 2.8, 0, 0],
    ["debian", "Debian 13 · netinst", "image", "media", "seed", 100, 0.784, 0, 2.4],
    ["fedora", "Fedora Workstation", "image", "archive", "wait", 0, 2.4, 0, 0],
    ["mint", "Linux Mint Cinnamon", "image", "archive", "wait", 0, 2.9, 0, 0],
  ];
  const torrents = torrentRows.map(([id, name, kind, diskId, state, progress, gb, down, up], rank) => ({
    id,
    name,
    kind,
    diskId,
    state,
    progress,
    sizeBytes: gb * GB,
    down,
    up,
    rank,
  }));
  const history = Array.from({ length: 181 }, (_, i) => [
    30 + (Math.floor(i / 19) % 3) * 6 + 8 * Math.sin(i * 0.09) + 5 * Math.sin(i * 0.61) + 3 * Math.sin(i * 1.83),
    9 + 3 * Math.sin(i * 0.12) + 2 * Math.sin(i * 0.59),
  ]);
  const rules = Object.fromEntries(
    ["Игры", "Фильмы", "Сериалы", "Музыка", "Софт", "Документы", "Прочее"].map((category) => [
      category,
      {
        target: "group",
        folder: category,
        index: "Обход папок",
        after:
          category === "Игры" ? "Сжатие NTFS" : ["Фильмы", "Сериалы"].includes(category) ? "HandBrake" : "Без обработки",
      },
    ]),
  );
  const example = {
    id: "copy-film",
    kind: "copy",
    title: "Копирование · Sintel.mkv",
    host: "mac",
    progress: 38,
    bytesPerSec: 36e6,
    etaSec: 61,
    state: "running",
    error: null,
    totalBytes: 3.5e9,
    operation: { type: "copy", fileId: "film-usb", target: "vault" },
  };

  function snapshot(scenario = "normal") {
    const data = structuredClone({
      hosts,
      disks,
      files,
      torrents,
      history,
      rules,
      tasks: [],
      manifests: {},
      comparisons: [],
      demoTransferRate: 12.6,
      automation: true,
      previewFresh: true,
      devices: [{ id: "tablet", name: "Планшет", online: true }],
      gamePool: "pool",
      imageDisk: "media",
      loading: scenario === "loading",
    });
    if (scenario === "empty" || data.loading) {
      for (const key of ["disks", "files", "torrents", "history"]) data[key] = [];
    } else if (scenario === "offline") {
      data.hosts.find((h) => h.id === "pc").online = false;
    } else if (scenario === "copying" || scenario === "error") {
      const task = structuredClone(example);
      if (scenario === "error")
        Object.assign(task, {
          state: "error",
          bytesPerSec: 0,
          etaSec: null,
          error: "Диск назначения отключился во время копирования.",
        });
      data.tasks.push(task);
    } else {
      data.tasks.push({
        id: "index-archive",
        kind: "index",
        title: "Индекс Archive HDD обновлён",
        host: "pc",
        progress: 100,
        bytesPerSec: 0,
        etaSec: 0,
        state: "done",
        error: null,
      });
    }
    return data;
  }
  return { scenarios, snapshot };
})();
