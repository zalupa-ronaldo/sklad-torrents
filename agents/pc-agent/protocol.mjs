/** Shared optical protocol. Hardware jobs are claimed only by the Windows worker. */

const LOCAL_MAC_BURN = /\b(?:drutil|hdiutil)\s+burn\b/i;
const REWRITABLE = new Set(["dvd+rw", "dvd-rw", "cd-rw", "bd-re"]);
const HARDWARE = new Set(["list-drives", "media-info", "burn", "verify", "discimagestudio-live"]);

export const WINDOWS_AGENT_HOST = "pc-agent";
export const MOCK_DRIVE_NAME = "HL-DT-ST DVDRAM GP57ES60";

export const MOCK_DRIVES = [
  {
    id: "win-dvd-0",
    name: MOCK_DRIVE_NAME,
    host: "pc-agent",
    letter: "E:",
    mediaType: "dvd+r",
    capacityBytes: 4700372992,
    blank: true,
    rewritable: false,
  },
  {
    id: "win-dvd-rw",
    name: "Optiarc DVD RW AD-7200S",
    host: "pc-agent",
    letter: "F:",
    mediaType: "dvd-rw",
    capacityBytes: 4700372992,
    blank: false,
    rewritable: true,
  },
];

export function isWindowsWorker(host) {
  return host === "pc-agent" || host === "windows";
}

export function isHardwareKind(kind) {
  return HARDWARE.has(kind);
}

export function isRewritable(mediaType) {
  return REWRITABLE.has(mediaType);
}

export function containsLocalMacBurn(argv, plan) {
  return LOCAL_MAC_BURN.test([...(argv ?? []), ...(plan ?? [])].join("\n"));
}

export function assertNoLocalMacBurn(argv, plan) {
  if (containsLocalMacBurn(argv, plan)) {
    const error = new Error("Локальная запись через macOS на этом задании запрещена.");
    error.code = "forbidden";
    error.name = "OpticalError";
    throw error;
  }
}

export function buildHardwarePlan(input) {
  const driveId = input.driveId ?? "";
  const sourcePath = input.sourcePath ?? "";
  let argv;
  let plan;
  if (input.kind === "discimagestudio-live") {
    // UnifiedCommandRunner help: developer command `burn-devices`.
    // It lists IMAPI2 recorders. It does not write a disc. There is no live-burn flag.
    argv = ["DiscImageStudio", "burn-devices"];
    plan = [
      "host=pc-agent",
      "command=burn-devices",
      "api=IMAPI2",
      "experimental=true",
      "writesDisc=false",
      "executor=windows-agent",
      "physicalDiscBurned=false",
    ];
  } else if (input.kind === "verify") {
    argv = ["pc-agent", "verify", "--drive", driveId, "--require-exit", "0"];
    plan = ["host=pc-agent", "verify=after-successful-burn-exit", "verifiedBy=pc-agent"];
  } else if (input.kind === "list-drives") {
    argv = ["pc-agent", "list-drives"];
    plan = ["host=pc-agent", "detection=windows", "media=dvd±r/rw"];
  } else if (input.kind === "media-info") {
    argv = ["pc-agent", "media-info", "--drive", driveId];
    plan = ["host=pc-agent", "detection=windows", "fields=capacity,mediaType"];
  } else {
    argv = ["pc-agent", "burn", "--imapi2", "--drive", driveId, "--source", sourcePath];
    plan = ["host=pc-agent", "api=IMAPI2", "executor=windows-agent", "physicalDiscBurned=false"];
  }
  if (input.eraseConfirmed && input.kind === "burn") {
    argv = [...argv, "--erase-rewritable", "confirmed"];
    plan = [...plan, "erase=explicit-confirm-stored-on-job", "eraseExecutor=pc-agent"];
  }
  assertNoLocalMacBurn(argv, plan);
  return { argv, plan };
}

export function buildOfflineImagePlan(input) {
  const profile = input.profile ?? "dvd";
  if (profile === "dvd-dl" || profile === "bd-dl" || profile === "bd-r-dl") {
    const error = new Error(
      profile.startsWith("bd")
        ? "Двухслойный BD DiscImageStudio не поддерживает. В документации только однослойный BD-R 25 ГБ."
        : "DVD-DL для рисунка на поверхности не поддерживается: пресеты DVD-R однослойные.",
    );
    error.code = "validation";
    error.name = "OpticalError";
    throw error;
  }
  const source = input.sourcePath ?? "";
  const output = input.outputPath ?? "";
  const dataDir = (input.dataDir ?? "").trim();
  const position = input.filePosition === "outer" ? "outer" : "inner";
  let argv;
  if (profile === "cd") {
    // README.en.md: ./disc-image-studio cd-generate --input picture.png --output sample.wav --sectors 2
    argv = ["disc-image-studio", "cd-generate", "--input", source, "--output", output, "--sectors", String(input.sectors ?? 359849)];
    if (dataDir) argv.push("--data-dir", dataDir, "--volume-label", input.volumeLabel || "CD_IMAGE", "--file-position", position);
  } else if (profile === "bd" || profile === "bd-r") {
    // docs/ADDING_BLURAY.md: bd-generate --input image.png --output bd-image.iso --preset bd-r-sl-25gb
    argv = [
      "disc-image-studio",
      "bd-generate",
      "--input",
      source,
      "--output",
      output,
      "--preset",
      "bd-r-sl-25gb",
      "--total-sectors",
      "12219392",
    ];
    if (dataDir) argv.push("--data-dir", dataDir, "--volume-label", input.volumeLabel || "BD_IMAGE", "--file-position", position);
  } else {
    // tests/test_cli_package.py: solve --image ... --iso-output ... --total-sectors N --fill-sectors N
    const sectors = String(input.totalSectors ?? 2295104);
    argv = ["disc-image-studio", "solve", "--image", source, "--iso-output", output, "--total-sectors", sectors];
    if (dataDir) {
      argv.push("--data-dir", dataDir, "--volume-label", input.volumeLabel || "DVD_IMAGE", "--file-position", position);
    } else {
      argv.push("--fill-sectors", sectors);
    }
  }
  const plan = [
    "mode=experimental-offline",
    "cli=disc-image-studio",
    "experimental=true",
    "drive=not-required",
    "live-burn=no",
    "imapi=no",
    "note=macOS/Linux CLI generates an image only",
  ];
  assertNoLocalMacBurn(argv, plan);
  return { argv, plan };
}

function cloneJob(job) {
  return {
    ...job,
    argv: [...(job.argv ?? [])],
    plan: [...(job.plan ?? [])],
    log: [...(job.log ?? [])],
    drives: Array.isArray(job.drives) ? job.drives.map((drive) => ({ ...drive })) : null,
    physicalDiscBurned: false,
  };
}

function unfinished(job, patch) {
  const verified = patch.verified === true && patch.verifiedBy === "pc-agent";
  return {
    ...cloneJob(job),
    ...patch,
    physicalDiscBurned: false,
    verified,
    verifiedBy: verified ? "pc-agent" : null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Claim and run one job. Only a Windows worker (`pc-agent` / `windows`) may call this.
 * Mock mode simulates the Windows process and never burns a physical disc.
 * With mock disabled, the job fails closed: IMAPI2 is not bundled here.
 */
export function claimAndExecute(job, options = {}) {
  const workerHost = options.workerHost ?? WINDOWS_AGENT_HOST;
  if (!isWindowsWorker(workerHost)) {
    const error = new Error("Только агент Windows забирает задания оптики.");
    error.code = "forbidden";
    error.name = "OpticalError";
    throw error;
  }
  if (!isWindowsWorker(job.host)) {
    const error = new Error("Задание не адресовано агенту Windows.");
    error.code = "forbidden";
    error.name = "OpticalError";
    throw error;
  }
  assertNoLocalMacBurn(job.argv, job.plan);

  const priorJobs = options.priorJobs ?? [];
  const existing = priorJobs.find((item) => item.id === job.id);
  if (existing && existing.status === "succeeded") {
    return cloneJob(existing);
  }

  const drives = options.drives ?? MOCK_DRIVES;
  const mock = options.mock !== false;
  const base = cloneJob(job);
  base.claimedBy = "pc-agent";
  base.host = job.host === "windows" ? "windows" : "pc-agent";

  if (!mock) {
    return unfinished(base, {
      status: "failed",
      simulation: false,
      burnExited: false,
      exitCode: null,
      progress: 1,
      error: "IMAPI2 не вшит в эту сборку. Агент Windows диск не записывал.",
      log: [...base.log, "pc-agent: отказ без имитации. Физический диск не записывался."],
    });
  }

  if (job.kind === "discimagestudio-offline") {
    return unfinished(base, {
      status: "succeeded",
      simulation: true,
      progress: 1,
      burnExited: false,
      exitCode: null,
      driveId: null,
      driveName: null,
      error: null,
      log: [...base.log, "pc-agent: экспериментальный офлайн-план CLI. Привод не нужен, диск не записывался."],
    });
  }

  if (job.kind === "list-drives") {
    return unfinished(base, {
      status: "succeeded",
      simulation: true,
      progress: 1,
      drives: drives.map((drive) => ({ ...drive })),
      driveName: drives.map((drive) => drive.name).join(", "),
      error: null,
      log: [...base.log, "pc-agent: список приводов собран на Windows. На Mac привод не искался."],
    });
  }

  const drive = drives.find((item) => item.id === job.driveId) ?? null;
  if (!drive) {
    return unfinished(base, {
      status: "failed",
      simulation: true,
      progress: 1,
      error: "Агент Windows не нашёл такой привод.",
      log: [...base.log, "pc-agent: привод не найден на Windows."],
    });
  }

  if (job.kind === "media-info") {
    return unfinished(base, {
      status: "succeeded",
      simulation: true,
      progress: 1,
      driveName: drive.name,
      mediaType: drive.mediaType,
      capacityBytes: drive.capacityBytes,
      error: null,
      log: [...base.log, `pc-agent: носитель ${drive.mediaType}, ${drive.capacityBytes ?? "?"} байт, привод «${drive.name}».`],
    });
  }

  const writing = job.kind === "burn" || job.kind === "discimagestudio-live";
  if (writing && drive.rewritable && !job.eraseConfirmed) {
    return unfinished(base, {
      status: "queued",
      simulation: true,
      progress: 0,
      driveName: drive.name,
      mediaType: drive.mediaType,
      capacityBytes: drive.capacityBytes,
      burnExited: false,
      exitCode: null,
      error: "Перезаписываемый диск не стирается автоматически. Нужно явное подтверждение.",
      log: [...base.log, "pc-agent: стирание не выполнялось."],
    });
  }

  if (job.kind === "verify") {
    const burned = priorJobs.find(
      (item) =>
        item.driveId === job.driveId &&
        (item.kind === "burn" || item.kind === "discimagestudio-live") &&
        item.status === "succeeded" &&
        item.burnExited === true &&
        item.exitCode === 0,
    );
    if (!burned) {
      return unfinished(base, {
        status: "failed",
        simulation: true,
        progress: 1,
        driveName: drive.name,
        mediaType: drive.mediaType,
        error: "Проверка только после успешного завершения записи на агенте Windows.",
        log: [...base.log, "pc-agent: проверка не начата, процесс записи ещё не завершился успешно."],
      });
    }
    return unfinished(base, {
      status: "succeeded",
      simulation: true,
      progress: 1,
      driveName: drive.name,
      mediaType: drive.mediaType,
      capacityBytes: drive.capacityBytes,
      burnExited: true,
      exitCode: 0,
      verified: true,
      verifiedBy: "pc-agent",
      error: null,
      log: [...base.log, "pc-agent: проверка после exit 0. Физический диск не записывался (имитация)."],
    });
  }

  const eraseLog =
    drive.rewritable && job.eraseConfirmed
      ? ["pc-agent: стирание перезаписываемого диска выполнил агент Windows."]
      : [];
  const burnLog =
    job.kind === "discimagestudio-live"
      ? "pc-agent: экспериментальный процесс IMAPI2 DiscImageStudio завершился. Диск здесь не записывался."
      : "pc-agent: процесс записи завершился с кодом 0. Проверка отдельно. Диск здесь не записывался.";
  return unfinished(base, {
    status: "succeeded",
    simulation: true,
    progress: 1,
    driveName: drive.name,
    mediaType: drive.mediaType,
    capacityBytes: drive.capacityBytes,
    burnExited: true,
    exitCode: 0,
    error: null,
    log: [...base.log, ...eraseLog, burnLog],
  });
}

/** Copy a Windows-agent report onto the Mac job. The Mac cannot mark a disc verified on its own. */
export function mergeAgentReport(local, remote) {
  const hardware = isHardwareKind(local.kind);
  const verified =
    hardware &&
    remote?.verified === true &&
    remote?.verifiedBy === "pc-agent" &&
    remote?.burnExited === true &&
    remote?.exitCode === 0;
  return {
    ...local,
    argv: [...local.argv],
    plan: [...local.plan],
    eraseConfirmed: Boolean(local.eraseConfirmed),
    host: hardware ? "pc-agent" : local.host,
    status: remote?.status ?? local.status,
    driveName: remote?.driveName ?? local.driveName,
    mediaType: remote?.mediaType ?? local.mediaType,
    capacityBytes: remote?.capacityBytes ?? local.capacityBytes,
    progress: typeof remote?.progress === "number" ? remote.progress : local.progress,
    exitCode: remote?.exitCode ?? null,
    burnExited: Boolean(remote?.burnExited),
    verified,
    verifiedBy: verified ? "pc-agent" : null,
    physicalDiscBurned: false,
    simulation: Boolean(remote?.simulation),
    error: remote?.error ?? null,
    log: Array.isArray(remote?.log) ? [...remote.log] : [...local.log],
    drives: Array.isArray(remote?.drives) ? remote.drives.map((drive) => ({ ...drive })) : local.drives,
    claimedBy: remote?.claimedBy === "pc-agent" ? "pc-agent" : null,
    updatedAt: remote?.updatedAt || new Date().toISOString(),
  };
}
