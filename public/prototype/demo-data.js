"use strict";

// The provider boundary is a plain snapshot. Each scenario returns independent records.
const DemoData = (() => {
  const GB = 1e9;
  const scenarios = [
    ["normal", "Норма"],
    ["offline", "ПК офлайн"],
    ["disk-offline", "Диск офлайн"],
    ["agent-error", "Ошибка агента ПК"],    ["copying", "Идёт копирование"],
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
      lastScan: new Date(Date.parse(lastSeen) - 37 * 60_000).toISOString(),
      mount,
      fs,
      location,
    };
  }
  const disks = [
    carrier("archive", "Archive HDD", "hdd", "pc", 8000, 3620, "D:/", "NTFS", "Холодный архив"),
    carrier("pool", "Game SSD", "ssd", "pc", 1000, 292, "C:/", "NTFS", "Игровой пул"),
    carrier("usb", "Флешка 01", "usb", "mac", 64, 31, "/Volumes/Flash/", "exFAT", "Рабочий стол"),
    carrier("camera", "Камера SD", "sd", "mac", 128, 0.75, "/Volumes/Camera/", "exFAT", "Картридер"),
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
  // SHA-256 of the fixture bytes "sklad-demo/" followed by the content ID.
  const checksums = {
    hades: "9d7af62c1bdc432019e3bbc4bd54c574cd958079d523f9a0fd845a3b74fb8dd2",
    gothic: "6106247d9010f48b39a31da0d76f6bbf3558b382d57cb0e06ef44e9d1c9edd7a",
    zelda: "61db60ddff3536ba6f917a2db56a72bb6b64e340c5f20b949bfa726832a3c719",
    gow: "62593ae71da74bfedc06d565f627cf98226a7ff375ef7de68fb5b52a71281a5f",
    hollow: "32daa58fbd36dc382b57f2317467fb398b56adc1f944f066e4232c223d17158b",
    film: "ca9e2274dc20d4aa9071353a82c93474227bb4ca7c446301ca787061c61cb52d",
    trailer: "3ccb2ed72994298d3d1d63195e39bf383d50d32e78ae56cad4b6bd1c12e4702d",
    osm: "694972e7be88e3f52e05aec23d0c91ad6acb83dacf0066d71cdc88e96b8fd790",
    blend: "e90edbe2371b8b83f35dd42cf681b4687ecdcc837d9d94633143a43d811fa24a",
    debian: "8ca5034e70e3c08b824069f6cbbc3d4c0b4cf0aabba2551204817dc7ccd5ce13",
    audio: "5600053820987c033abe5313c1bae5acb6afcd53cff886d92f1868668f09754b",
    book: "4f18860af4a363e3f56ca35bf06965de253c9d661de896ce0540d60a7e7ffbbb",
    control: "8b0863e2cbfcee8ddb0e576e2d3ac9501e56e60f507c7a90340cb3c01faf8848",
    "hollow-windows": "b988e2212c87adcc4d27381fa984434bf71ea33238658c283dde3cd2ad50db85",
    disco: "8ab31e72869201eae7786c4fea0e3cac35459308f7c9d18200da5eee754a1498",
    cyberpunk: "2798a5b44445d81a1c27cec561a7bf4fbceb18b1c27b7ed67d8912c95a1c9067",
    "death-stranding": "ab0df7e93fb45a2f030295c55b0b206ac77071fda11f28516ba6dcbfb4600f7a",
    satisfactory: "8d66630e6d7853028f647ab7e17f218519c7ba64b54ec3142279f19276132d43",
    "baldurs-gate": "7cffeeb7227514c4d444beb1cbbcef4bccc8ced4fcbe7d3f47578ea349d17e56",
    witcher: "7bb766f0071fed6b8710f7e0d5fe7b93885c2014dcf434680c6e38ef764796e7",
    terraria: "dd5528a65c9bc2aab1e337e3a86248430748f7f3ff70b92c4ca01dcfa2127af4",
    celeste: "ffdaff15a5274b5692f44f0f83f46787e0fc90baa757029293c6252795abec84",    "av1:trailer": "ee7e21703df01c00304b5018ebc6a8f9dd29469c3fe61266e1d38811dd625ef5",
    "av1:film": "715fe75929921317644a12804e6a311faf490be2873bc72a07caf41990127268",
  };
  function file(id, name, diskId, dir, type, size, extra = {}) {
    return { id, name, diskId, dir, type, sizeBytes: Math.round(size * GB), contentId: id, ...extra };
  }
  const files = [
    file("hades", "Hades", "archive", "Games/", "Игра", 11.1, { platform: "Windows", expectedSaving: 0.24 }),
    file("gothic", "Gothic II", "archive", "Games/", "Игра", 3.6, { platform: "Windows" }),
    file("zelda", "Breath of the Wild", "archive", "Switch/", "Игра", 14.4, { platform: "Switch" }),
    file("gow", "Chains of Olympus", "archive", "PSP/", "Игра", 1.5, { platform: "PSP" }),
    file("hollow", "Hollow Knight.app", "data", "Games/", "Игра", 7.8, { platform: "macOS" }),
    file("film", "Sintel.mkv", "media", "Movies/", "Видео", 3.5, {
      tracks: [
        { kind: "video", codec: "H.264", details: "1920 × 1080 · 24 кадр/с" },
        { kind: "audio", codec: "AAC", details: "Английский · 5.1 · 48 кГц" },
      ],
    }),
    file("trailer", "Spring.mkv", "vault", "Movies/", "Видео", 1.1, {
      tracks: [
        { kind: "video", codec: "H.264", details: "1920 × 1080 · 24 кадр/с" },
        { kind: "audio", codec: "AAC", details: "Стерео · 48 кГц" },
      ],
    }),
    file("osm", "OpenStreetMap · Europe", "archive", "Maps/", "Данные", 31.6, { torrentId: "osm" }),
    file("blend", "Blender Demo Files", "vault", "Downloads/", "Архив", 8.4, { torrentId: "blend" }),
    file("debian", "Debian 13 · netinst", "media", "ISO/", "Образ", 0.784, { torrentId: "debian" }),
    file("audio", "Концерт.flac", "cd", "Audio/", "Музыка", 0.48, {
      tracks: [{ kind: "audio", codec: "FLAC", details: "Стерео · 44,1 кГц" }],
    }),
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
  const torrentHashes = {
    ubuntu: "840731a210cf1306ad67cb5a6d8b1ce9c8f288e6",
    bunny: "826646224f7a23b504ad5a39df895529b71deabc",
    osm: "421d9ebe4a4205cdfa8337144a3aa8a6549e39d3",
    blend: "139594feb134d2ae0ede2fbc032933bdc7952359",
    music: "5dbfc679e31252b118e4a2f8a166343fa85e966c",
    debian: "0e8f5cc253ff5533145f881f26f60e9f9e5843c8",
    fedora: "34a68505bbf65e1211e8b42eb8c7ac5e1d085013",
    mint: "e9a629b932213a6c5c612c03bd06dd6bbf2403b0",
  };
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

  const av1 = {
    id: "encode-spring",
    kind: "av1",
    title: "AV1 · Spring.mkv",
    host: "mac",
    progress: 26,
    bytesPerSec: 4e6,
    etaSec: 204,
    state: "running",
    error: null,
    totalBytes: 1.1e9,
    operation: { type: "encode", fileId: "trailer", content: "av1:trailer", size: 737e6, target: "media", dir: "Фильмы/" },
  };

  // Source: IridiumIO/CompactGUI database.json @ 470e294e44d912b89d7f51775e20397dce978efc.
  const communityEstimates = {
    hades: { percent: 5.2, samples: 11 },
    control: { percent: 39.8, samples: 54 },
    hollow: { percent: 77.4, samples: 75 },
    disco: { percent: 6.3, samples: 6 },
    cyberpunk: { percent: 2.6, samples: 108 },
    gothic: { percent: 17.1, samples: 3 },
    "death-stranding": { percent: 0.1, samples: 15 },
    satisfactory: { percent: 45.7, samples: 46 },
    "baldurs-gate": { percent: 11.5, samples: 131 },
    witcher: { percent: 3.9, samples: 66 },
    terraria: { percent: 13.8, samples: 43 },
    celeste: { percent: 18.8, samples: 8 },
  };
  // Local installations; Steam AppIDs identify the matching CompactGUI community records.
  // id, title, Steam AppID, installed launcher, disk, archive, GB before/allocated,
  // compression state, algorithm, last launch, flags.
  const installations = [
    ["hades", "Hades", 1145360, "Steam", "archive", "archive", 11.1, 8.4, "compressed", "XPRESS8K", "2026-11-16"],
    ["control", "Control", 870780, "Epic", "pool", "media", 42.6, 35.2, "compressed", "LZX", "2026-11-18", "running"],
    ["hollow", "Hollow Knight", 367520, "Steam", "pool", "archive", 9.2, 6.4, "compressed", "XPRESS16K", "2026-11-17"],
    ["disco", "Disco Elysium", 632470, "GOG", "archive", "archive", 19.8, 14.5, "partial", "XPRESS8K", "2026-10-27"],
    ["cyberpunk", "Cyberpunk 2077", 1091500, "GOG", "media", "media", 88.4, 88.4, "plain", "LZX", "2026-10-12"],
    ["gothic", "Gothic II", 39510, "Без лаунчера", "archive", "archive", 3.6, 3.6, "plain", "XPRESS4K", "2026-11-03"],
    [
      "death-stranding",
      "Death Stranding Director’s Cut",
      1850570,
      "Epic",
      "media",
      "media",
      69.4,
      65.8,
      "compressing",
      "XPRESS16K",
      "2026-11-14",
    ],
    ["satisfactory", "Satisfactory", 526870, "Steam", "archive", "archive", 31.2, 31.2, "queued", "XPRESS8K", "2026-11-08"],
    [
      "baldurs-gate",
      "Baldur’s Gate 3",
      1086940,
      "Steam",
      "archive",
      "archive",
      151.3,
      138.7,
      "partial",
      "LZX",
      "2026-11-12",
    ],
    ["witcher", "The Witcher 3", 292030, "GOG", "backup", "backup", 52.1, 46.7, "compressed", "XPRESS16K", "2026-10-18"],
    ["terraria", "Terraria", 105600, "Без лаунчера", "archive", "archive", 0.73, 0.73, "plain", "XPRESS4K", "2026-10-30"],
    ["celeste", "Celeste", 504230, "Steam", "media", "media", 1.2, 0.84, "compressed", "XPRESS8K", "2026-11-06"],
  ];

  function seedLibrary(data, scenario) {
    data.gameAgentError = ["error", "agent-error"].includes(scenario);
    data.gameLibrary = [];
    const livePanel = location.hash === "#games" && new URLSearchParams(location.search).get("demo") !== "1";
    data.liveLibrary = livePanel;
    if (livePanel || !data.disks.length) return;
    const pool = data.disks.find((d) => d.id === data.gamePool);
    pool.freeBytes = 94.8 * GB;
    if (scenario === "disk-offline") data.disks.find((d) => d.id === "media").online = false;
    for (const [
      id,
      title,
      appId,
      launcher,
      diskId,
      archiveId,
      size,
      allocated,
      status,
      algorithm,
      lastPlayed,
      flag,
    ] of installations) {
      const fileId = id === "hollow" ? "hollow-windows" : id,
        archivePath = archiveId === "backup" ? "E:/" : data.disks.find((d) => d.id === archiveId).mount;
      let f = data.files.find((f) => f.id === fileId);
      if (!f) {
        f = file(fileId, title, diskId, "Games/", "Игра", size, { platform: "Windows" });
        data.files.push(f);
      }
      Object.assign(f, { allocatedBytes: Math.round(allocated * GB), dir: "Games/", sizeBytes: Math.round(size * GB) });
      data.gameLibrary.push({
        id,
        fileId,
        title,
        appId,
        launcher,
        archiveId,
        archivePath,
        cover: "art/" + id + ".jpg",
        portrait: ["control", "hollow"].includes(id) ? "art/" + id + "-portrait.jpg" : null,
        algorithm,
        status,
        lastPlayed,
        running: flag === "running",
        progress: status === "compressing" ? 42 : 0,
        community: communityEstimates[id],
        history: diskId === data.gamePool ? [{ at: lastPlayed, from: archiveId, to: diskId }] : [],
      });
    }
  }  function snapshot(scenario = "normal") {
    const data = structuredClone({
      hosts,
      disks,
      files,
      checksums,
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
      data.tasks.push({
        ...structuredClone(av1),
        state: "paused",
        bytesPerSec: 0,
        resumeRate: av1.bytesPerSec,
        etaSec: null,
      });
    } else if (scenario === "copying" || scenario === "error") {
      const task = structuredClone(example);
      if (scenario === "error")
        Object.assign(task, {
          state: "error",
          bytesPerSec: 0,
          etaSec: null,
          error: "Диск назначения отключился во время копирования.",
        });
      const encode = structuredClone(av1);
      if (scenario === "error")
        Object.assign(encode, {
          state: "error",
          bytesPerSec: 0,
          etaSec: null,
          error: "Выходной контейнер не прошёл проверку дорожек.",
        });
      data.tasks.push(task, encode);
      if (scenario === "error")
        data.tasks.push({
          id: "scan-usb",
          kind: "index",
          title: "Индексация · Флешка 01",
          host: "mac",
          totalBytes: disks.find((d) => d.id === "usb").sizeBytes,
          progress: 14,
          bytesPerSec: 0,
          etaSec: null,
          state: "error",
          error: "Не удалось прочитать каталог. Сохранён предыдущий снимок.",
          operation: { type: "index", target: "usb" },
        });
    } else {
      data.tasks.push(
        {
          ...structuredClone(example),
          id: "copied-to-usb",
          host: "pc",
          progress: 100,
          bytesPerSec: 0,
          etaSec: 0,
          state: "done",
          verified: true,
          operation: { type: "copy", fileId: "film", target: "usb" },
        },
        {
          id: "index-archive",
          kind: "index",
          title: "Индекс Archive HDD обновлён",
          host: "pc",
          progress: 100,
          bytesPerSec: 0,
          etaSec: 0,
          state: "done",
          error: null,
        },
      );
    }
    const blank = scenario === "empty" || data.loading;
    if (blank) {
      data.hosts = [];
      data.devices = [];
      data.rules = {};
    }
    for (const h of data.hosts) {
      Object.assign(
        h,
        h.id === "mac"
          ? { os: "macOS", address: "http://mac-mini.local:8080", folder: "/Volumes/vault/Downloads" }
          : { os: "Windows", address: "http://storage-pc.local:8080", folder: "D:/Downloads" },
      );
      h.defaults = { name: h.name, os: h.os, address: h.address, folder: h.folder };
    }
    for (const t of data.torrents) t.infoHash = torrentHashes[t.id];
    data.cancelled = [];
    data.reclaimedBytes = 0;
    data.compressionRatios = { XPRESS4K: 0.12, XPRESS8K: 0.18, XPRESS16K: 0.22, LZX: 0.25 };
    data.schedule = {
      enabled: !blank,
      start: "01:00",
      end: "07:00",
      days: "Ежедневно",
      lastRun: null,
      clock: Date.parse("2026-11-18T14:30:00Z"),
    };
    data.toolPaths = Object.fromEntries(
      data.hosts.map((h) => [
        h.id,
        h.os === "Windows"
          ? {
              encoder: "C:/Program Files/HandBrake/HandBrakeCLI.exe",
              agent: "http://storage-pc.local:4730",
              compact: "C:/Windows/System32/compact.exe",
            }
          : { encoder: "/opt/homebrew/bin/HandBrakeCLI", agent: "", compact: "" },
      ]),
    );
    data.encodingProfiles = {
      "AV1 1080p": { fps: 24, saveRatio: 0.33, height: 1080 },
      "AV1 720p": { fps: 38, saveRatio: 0.49, height: 720 },
      "AV1 исходное разрешение": { fps: 18, saveRatio: 0.27, height: null },
    };
    data.toolSettings = { preset: "AV1 1080p", algorithm: "XPRESS8K" };
    data.sendSettings = { alias: "Склад", port: 53317, discovery: true, inbox: "vault" };
    data.opticalDrive = blank
      ? null
      : { host: "pc", name: "DVD-RW · Windows PC", open: false, medium: "DVD-5", writable: true };
    data.opticalImages = blank
      ? []
      : [{ id: "debian", name: "Debian 13 · netinst.iso", diskId: "media", fileId: "debian", sizeBytes: 784e6 }];
    data.faults =
      scenario === "error"
        ? {
            hosts: "Агент не ответил на последний запрос.",
            devices: "Не удалось прочитать каталог флешки.",
            torrents: "qBittorrent не подтвердил операцию.",
            task: "Последняя операция завершилась ошибкой.",
            scheduler: "Предыдущий запуск конвейера был прерван.",
            localsend: "Устройство отклонило передачу.",
            optical: "Привод сообщил об ошибке записи.",
            policies: "Назначение правила было недоступно.",
            games: "Не удалось подготовить игровую копию.",
            media: "Кодировщик прервал обработку файла.",
            move: "Копирование было прервано до сверки.",
            integrity: "Не удалось считать контрольную сумму.",
            index: "Индексатор прервал чтение.",
            drives: "Не удалось обновить снимок каталога.",
            details: "Предыдущая операция с файлом прервана.",
          }
        : {};
    data.failNext = { ...data.faults };
    if (["copying", "error", "offline"].includes(scenario)) {
      const jobs = [
        ["demo-send", "send", "LocalSend · Каталог.pdf", "mac", 24e6, { type: "send", fileId: "book", peer: "pc" }],
        [
          "demo-image",
          "image",
          "Образ · Debian 13.iso",
          "pc",
          784e6,
          { type: "image", fileId: "debian", target: "media", name: "Debian 13.iso" },
        ],
        [
          "demo-game",
          "game",
          "Подготовка игры · Gothic II",
          "pc",
          3.6e9,
          { type: "game", fileId: "gothic", target: "pool", dir: "Games/" },
        ],
        [
          "demo-rule",
          "placement",
          "Раскладка · Blender Demo Files",
          "mac",
          8.4e9,
          { type: "place", fileId: "blend", target: "archive", torrentId: "blend", dir: "Прочее/" },
        ],
        [
          "demo-migrate",
          "copy",
          "Перенос раздачи · OpenStreetMap",
          "pc",
          31.6e9,
          { type: "copy", fileId: "osm", target: "vault", torrentId: "osm", moveSource: true },
        ],
      ];
      for (const [id, kind, title, host, totalBytes, operation] of jobs) {
        const running = scenario === "copying",
          speed = Math.ceil(totalBytes / 120);
        data.tasks.push({
          id,
          kind,
          title,
          host,
          totalBytes,
          operation,
          progress: 25,
          bytesPerSec: running ? speed : 0,
          resumeRate: speed,
          etaSec: running ? 90 : null,
          state: running ? "running" : scenario === "offline" ? "paused" : "error",
          error: scenario === "error" ? "Агент не подтвердил завершение. Можно повторить задачу." : null,
        });
      }
    }
    for (const j of data.tasks) {
      j.events = [
        { time: "2026-11-18T14:20:00Z", text: "Задача создана" },
        {
          time: "2026-11-18T14:25:00Z",
          text:
            j.error ||
            { done: "Операция завершена", running: "Обработка началась", paused: "Ожидание подключения" }[j.state],
        },
      ];
      if (j.id === "copied-to-usb") {
        j.copyId = "film-usb";
        j.checksum = data.checksums.film;
        data.manifests[j.copyId] = j.checksum;
      }
    }
    seedLibrary(data, scenario);
    if (scenario === "error") {
      delete data.faults.games;
      delete data.failNext.games;
    }
    if (scenario === "copying") {
      const f = data.files.find((f) => f.id === "celeste"),
        d = data.disks.find((d) => d.id === data.gamePool);
      d.freeBytes -= f.sizeBytes;
      data.tasks.unshift({
        id: "playing-celeste",
        kind: "copy",
        title: "Перенос игры · Celeste",
        host: "pc",
        progress: 8,
        bytesPerSec: f.sizeBytes / 5,
        etaSec: 13,
        totalBytes: f.sizeBytes,
        state: "running",
        error: null,
        events: [{ time: "2026-11-18T14:30:00Z", text: "Начато копирование на SSD." }],
        operation: { type: "libraryMove", fileId: f.id, gameId: "celeste", target: d.id },
        flow: { from: f.diskId, step: 0, percent: 40, reserved: f.sizeBytes, sourceStatus: "compressed", confirmed: false },
      });
    }    return data;
  }
  return { scenarios, snapshot };
})();
