#!/usr/bin/env node
/**
 * Общая логика одной команды установки Склада.
 *
 * Mac и WSL: bash scripts/one-command.sh
 * Windows:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\one-command.ps1
 *
 * Продуктовый код не меняет. Диск Z: не читает. Секреты, прошивки и ключи не скачивает.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STEP_TITLES = {
  "npm-ci": "Зависимости npm",
  "qbittorrent-nox": "Пакет qbittorrent-nox",
  "wsl-qbittorrent": "qbittorrent-nox в Ubuntu WSL",
  "probe-mac-tools": "HandBrakeCLI и qBittorrent на Mac",
  "probe-win-tools": "compact.exe и HandBrakeCLI.exe",
  "npm-ci-refused-on-mnt": "npm в WSL поверх диска Windows",
  "status-file": "Отметка data/one-command.json",
};

export function isForbiddenDrivePath(input) {
  const text = String(input ?? "").trim();
  if (!text) return false;
  if (/^[Zz]:([\\/]|$)/.test(text)) return true;
  if (/^\\\\\?\\[Zz]:/.test(text)) return true;
  return /^\/mnt\/[zZ](\/|$)/.test(text.replaceAll("\\", "/"));
}

export function windowsPathToWsl(input) {
  const text = String(input ?? "").trim();
  if (isForbiddenDrivePath(text)) throw new Error("Диск Z: не используется.");
  const match = /^([A-Ya-y]):(?:[\\/](.*))?$/.exec(text);
  if (!match) throw new Error("Ожидался путь Windows с буквой диска, кроме Z:.");
  const rest = (match[2] ?? "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const drive = match[1].toLowerCase();
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

export function isWindowsDriveMount(dir) {
  return /^\/mnt\/[A-Ya-y](\/|$)/.test(String(dir ?? "").replaceAll("\\", "/"));
}

export function detectRole({ platform, env = {}, procVersion = "" }) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(String(procVersion));
  if (platform === "linux" && wsl) return "wsl";
  if (platform === "linux") return "linux";
  return "unknown";
}

export function parseNodeMajor(versionText) {
  const match = /^v?(\d+)/.exec(String(versionText ?? "").trim());
  return match ? Number(match[1]) : Number.NaN;
}

export function assertSupportedNode(versionText) {
  const major = parseNodeMajor(versionText);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Нужен Node.js 22 или новее. Сейчас: ${versionText || "не найден"}.`);
  }
}

export function planFor(role, { withPanel = false, repoOnWindowsMount = false } = {}) {
  const steps = [];
  if (role === "mac" || role === "linux" || role === "win") steps.push("npm-ci");
  if (role === "mac") steps.push("probe-mac-tools");
  if (role === "win") steps.push("probe-win-tools", "wsl-qbittorrent");
  if (role === "wsl") {
    steps.push("qbittorrent-nox");
    if (withPanel) steps.push(repoOnWindowsMount ? "npm-ci-refused-on-mnt" : "npm-ci");
  }
  steps.push("status-file");
  return steps;
}

export function buildStatus(input) {
  return {
    writtenAt: input.writtenAt,
    role: input.role,
    platform: input.platform,
    node: input.node,
    actions: [...input.actions],
    notes: [...input.notes],
    ok: input.ok === true,
    zDrive: "ignored",
    secretsWritten: false,
    firmwareDownloaded: false,
  };
}

function procVersion() {
  try {
    return existsSync("/proc/version") ? readFileSync("/proc/version", "utf8") : "";
  } catch {
    return "";
  }
}

function printHelp() {
  process.stdout.write(`Склад — одна команда установки

Mac и Ubuntu WSL:
  bash scripts/one-command.sh

Windows (PowerShell из корня репозитория, эта же команда ставит qbittorrent-nox в WSL):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\one-command.ps1

Проверка без изменений:
  bash scripts/one-command.sh --check

Откат служебной отметки, без удаления data с хостами и без снятия пакетов:
  bash scripts/one-command.sh --rollback

Откат вместе с node_modules:
  bash scripts/one-command.sh --rollback --purge-modules

Диск Z: не читается. Пароли, прошивки, BIOS и ключи не скачиваются и в git не пишутся.
Подробности: docs/ustanovka.md
`);
}

function assertRepoAllowed(dir) {
  const candidates = [dir];
  try {
    candidates.push(realpathSync(dir));
  } catch {
    // The original path is still checked.
  }
  for (const item of candidates) {
    if (isForbiddenDrivePath(item)) throw new Error("Диск Z: не используется.");
  }
}

function knownArgs(argv) {
  const known = new Set([
    "--check",
    "--rollback",
    "--self-test",
    "--help",
    "-h",
    "--with-panel",
    "--purge-modules",
    "--qbittorrent-only",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--role") {
      index += 1;
      if (!argv[index]) throw new Error("После --role нужно имя: mac, win, wsl или linux.");
      continue;
    }
    if (!known.has(arg)) throw new Error(`Неизвестный аргумент: ${arg}. bash scripts/one-command.sh --help`);
  }
}

function lastFlag(argv, name) {
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) value = argv[index + 1] ?? null;
  }
  return value;
}

function run(command, args, { allowFail = false, env } = {}) {
  return new Promise((resolve, reject) => {
    // Node 18.20+/20.12+/22 refuses to spawn .cmd/.bat without a shell (spawn EINVAL).
    // Arguments here are fixed literals, so shell mode on Windows is safe.
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: env ?? process.env,
      shell: needsShell,
    });
    child.on("error", (error) => {
      if (allowFail) resolve({ code: 127, error });
      else reject(error);
    });
    child.on("exit", (code) => {
      const result = { code: code ?? 1 };
      if (result.code !== 0 && !allowFail) {
        const error = new Error(`Команда завершилась с кодом ${result.code}: ${command}`);
        error.exitCode = result.code;
        reject(error);
      } else resolve(result);
    });
  });
}

function commandExists(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return Promise.resolve(false);
  const command = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [name] : ["-c", `command -v ${name}`];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function npmCi(check) {
  if (check) {
    process.stdout.write("Проверка: npm ci --no-audit --no-fund\n");
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["ci", "--no-audit", "--no-fund"]);
}

async function installQbittorrent(check) {
  if (await commandExists("qbittorrent-nox")) {
    process.stdout.write("qbittorrent-nox уже установлен.\n");
    return "present";
  }
  if (check) {
    process.stdout.write("Проверка: был бы установлен только пакет qbittorrent-nox.\n");
    return "would-install";
  }
  const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  const update = await run("sudo", ["-n", "apt-get", "update"], { allowFail: true, env });
  if (update.code !== 0) {
    const error = new Error(
      "Нужен sudo без запроса пароля. В Ubuntu WSL выполните: sudo apt-get update && sudo apt-get install -y --no-install-recommends qbittorrent-nox",
    );
    error.exitCode = 2;
    throw error;
  }
  await run("sudo", ["-n", "apt-get", "install", "-y", "--no-install-recommends", "qbittorrent-nox"], { env });
  return "installed";
}

async function installQbittorrentViaWsl(check) {
  if (process.platform !== "win32") {
    process.stdout.write("Часть WSL выполняется на Windows через wsl.exe. Здесь она только в плане.\n");
    return "skipped-not-windows";
  }
  const script = windowsPathToWsl(path.join(root, "scripts", "one-command.sh"));
  if (check) {
    process.stdout.write(`Проверка: wsl.exe -e bash ${script} --qbittorrent-only --check\n`);
    return "would-run";
  }
  const wsl = (await commandExists("wsl.exe")) ? "wsl.exe" : "wsl";
  if (!(await commandExists("wsl.exe")) && !(await commandExists("wsl"))) {
    const error = new Error("wsl.exe не найден. Включите Ubuntu WSL и повторите ту же команду.");
    error.exitCode = 2;
    throw error;
  }
  const result = await run(wsl, ["-e", "bash", script, "--qbittorrent-only"], { allowFail: true });
  if (result.code !== 0) {
    const error = new Error("Установка qbittorrent-nox в WSL не завершилась. Текст sudo — выше, пароль в скрипт не входит.");
    error.exitCode = result.code === 127 ? 2 : result.code;
    throw error;
  }
  return "delegated";
}

async function probeMac() {
  const notes = [];
  for (const name of ["HandBrakeCLI", "qbittorrent"]) {
    notes.push((await commandExists(name)) ? `Найден: ${name}` : `Пока нет в PATH: ${name}`);
  }
  return notes;
}

function probeWin() {
  const files = ["C:\\Windows\\System32\\compact.exe", "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe"];
  if (process.platform !== "win32") return ["Файлы Windows не проверялись: это не Windows, диск не обходится."];
  return files.map((file) => {
    if (isForbiddenDrivePath(file)) throw new Error("Диск Z: не используется.");
    return existsSync(file) ? `Найден: ${file}` : `Пока нет: ${file}`;
  });
}

function addNotes(notes, lines) {
  for (const line of lines) {
    notes.push(line);
    process.stdout.write(`${line}\n`);
  }
}

function nextSteps(role) {
  if (role === "mac") {
    return [
      "Панель: npm run dev",
      "Адрес: http://127.0.0.1:4317",
      "Агент полки Mac: node --import ./agents/register.mjs agents/mac-agent/drive.mts --port 4371",
    ];
  }
  if (role === "win") {
    return [
      "Агент заданий, макет: npm run pc-agent",
      "Агент полки Windows (Windows Node, не WSL): node --import ./agents/register.mjs agents/pc-agent/drive.mts --port 4372",
      "qBittorrent в Ubuntu WSL: qbittorrent-nox",
      "Панель на этом ПК, если она не на Mac: npm run dev",
    ];
  }
  if (role === "wsl") {
    return [
      "qBittorrent: qbittorrent-nox",
      "Временный пароль первого запуска остаётся в этом терминале и в git не копируется.",
      "Панель и агент Windows этой командой в WSL не запускаются.",
    ];
  }
  return [
    "Это не Mac и не Windows. Зависимости панели поставлены для проверки.",
    "На Mac: bash scripts/one-command.sh",
    "На Windows: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\one-command.ps1",
  ];
}

function writeStatus(report, check) {
  if (check) {
    process.stdout.write("Проверка: data/one-command.json не пишется.\n");
    return;
  }
  mkdirSync(path.join(root, "data"), { recursive: true });
  writeFileSync(path.join(root, "data", "one-command.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write("Отметка установки: data/one-command.json (в git не входит).\n");
}

function rollback(check, purgeModules) {
  const marker = path.join(root, "data", "one-command.json");
  const modules = path.join(root, "node_modules");
  if (check) {
    process.stdout.write(existsSync(marker) ? "Проверка: снял бы data/one-command.json.\n" : "Проверка: отметки data/one-command.json нет.\n");
    process.stdout.write(purgeModules ? "Проверка: удалил бы node_modules.\n" : "Проверка: node_modules не трогается.\n");
  } else if (existsSync(marker)) {
    rmSync(marker);
    process.stdout.write("Снята отметка data/one-command.json.\n");
  } else {
    process.stdout.write("Отметки data/one-command.json нет.\n");
  }
  if (!check && purgeModules && existsSync(modules)) {
    rmSync(modules, { recursive: true, force: true });
    process.stdout.write("Удалён node_modules.\n");
  }
  process.stdout.write("Файлы в data, кроме отметки установки, не удалялись. Диски не трогались.\n");
  process.stdout.write("Пакет qbittorrent-nox не снимался. Если он больше не нужен, в Ubuntu WSL: sudo apt-get remove qbittorrent-nox\n");
}

async function execute(role, { check, withPanel }) {
  const repoOnWindowsMount = isWindowsDriveMount(root);
  if (role === "win" && process.platform !== "win32" && !check) {
    throw new Error("Команда Windows запускается в PowerShell на Windows.");
  }
  if (role === "mac" && process.platform !== "darwin" && !check) {
    throw new Error("Команда Mac запускается на macOS.");
  }
  if ((role === "mac" || role === "win" || role === "linux") && !check) assertSupportedNode(process.version);
  if (role === "wsl" && withPanel && !check) assertSupportedNode(process.version);

  const steps = planFor(role, { withPanel, repoOnWindowsMount });
  const done = [];
  const notes = [];
  let ok = true;
  let exitCode = 0;
  try {
    for (const step of steps) {
      process.stdout.write(`\n— ${STEP_TITLES[step] ?? step}\n`);
      if (step === "npm-ci") await npmCi(check);
      else if (step === "qbittorrent-nox") notes.push(await installQbittorrent(check));
      else if (step === "wsl-qbittorrent") notes.push(await installQbittorrentViaWsl(check));
      else if (step === "probe-mac-tools") addNotes(notes, check ? ["Проверка: программы Mac не запускались."] : await probeMac());
      else if (step === "probe-win-tools") addNotes(notes, check ? ["Проверка: файлы Windows не открывались."] : probeWin());
      else if (step === "npm-ci-refused-on-mnt") {
        addNotes(notes, ["Репозиторий лежит на /mnt/<диск Windows>. npm здесь пропущен, чтобы не смешать node_modules с Windows."]);
      }
      if (step !== "status-file") done.push(step);
    }
  } catch (error) {
    ok = false;
    exitCode = Number(error.exitCode) || 1;
    notes.push(error instanceof Error ? error.message : "Установка не завершилась.");
    process.stderr.write(`${notes[notes.length - 1]}\n`);
  }
  writeStatus(
    buildStatus({
      writtenAt: new Date().toISOString(),
      role,
      platform: process.platform,
      node: process.version,
      actions: done,
      notes,
      ok,
    }),
    check,
  );
  if (ok) {
    process.stdout.write("\nДальше:\n");
    for (const line of nextSteps(role)) process.stdout.write(`  ${line}\n`);
  }
  return exitCode;
}

function selfTest() {
  const eq = (actual, expected, label) => {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    if (left !== right) throw new Error(`${label}: ${left} !== ${right}`);
  };
  for (const item of ["Z:\\", "Z:/Games", "z:\\", "z:", "\\\\?\\Z:\\", "/mnt/z", "/mnt/z/foo", "/mnt/Z", "/mnt/Z/a"]) {
    if (!isForbiddenDrivePath(item)) throw new Error(`Должен быть запрещён: ${item}`);
  }
  for (const item of ["", "C:\\Users\\z", "C:\\z", "/mnt/c/Users/z", "/mnt/zip", "/home/brokerworker", "/Volumes/vault", "D:\\Downloads", "/agent/repos/sklad-torrents"]) {
    if (isForbiddenDrivePath(item)) throw new Error(`Не должен быть запрещён: ${item}`);
  }
  eq(windowsPathToWsl("C:\\repo\\sklad"), "/mnt/c/repo/sklad", "wsl path");
  eq(windowsPathToWsl("D:/a b/c"), "/mnt/d/a b/c", "wsl spaces");
  eq(windowsPathToWsl("C:\\"), "/mnt/c", "wsl root");
  let threw = false;
  try {
    windowsPathToWsl("Z:\\secret");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("Z: обязан отклоняться до преобразования пути.");
  eq(detectRole({ platform: "darwin" }), "mac", "mac");
  eq(detectRole({ platform: "win32" }), "win", "win");
  eq(detectRole({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "wsl", "wsl env");
  eq(detectRole({ platform: "linux", procVersion: "Linux Microsoft" }), "wsl", "wsl proc");
  eq(detectRole({ platform: "linux", env: {}, procVersion: "Linux" }), "linux", "linux");
  eq(parseNodeMajor("v22.23.4"), 22, "node 22");
  let nodeThrew = false;
  try {
    assertSupportedNode("v20.0.0");
  } catch {
    nodeThrew = true;
  }
  if (!nodeThrew) throw new Error("Node 20 обязан отклоняться.");
  assertSupportedNode("v22.0.0");
  eq(planFor("mac"), ["npm-ci", "probe-mac-tools", "status-file"], "plan mac");
  eq(planFor("win"), ["npm-ci", "probe-win-tools", "wsl-qbittorrent", "status-file"], "plan win");
  eq(planFor("wsl"), ["qbittorrent-nox", "status-file"], "plan wsl");
  eq(planFor("linux"), ["npm-ci", "status-file"], "plan linux");
  eq(
    planFor("wsl", { withPanel: true, repoOnWindowsMount: true }),
    ["qbittorrent-nox", "npm-ci-refused-on-mnt", "status-file"],
    "plan wsl mount",
  );
  const status = buildStatus({
    writtenAt: "2026-11-15T00:00:00.000Z",
    role: "linux",
    platform: "linux",
    node: "v22.0.0",
    actions: ["npm-ci"],
    notes: [],
    ok: true,
    PATH: "/secret",
    password: "no",
  });
  eq(
    Object.keys(status),
    ["writtenAt", "role", "platform", "node", "actions", "notes", "ok", "zDrive", "secretsWritten", "firmwareDownloaded"],
    "status keys",
  );
  if (status.secretsWritten !== false || status.firmwareDownloaded !== false || status.zDrive !== "ignored") {
    throw new Error("Отчёт установки обязан явно исключать секреты, прошивки и Z:.");
  }
  if (JSON.stringify(status).includes("/secret") || JSON.stringify(status).includes("password")) {
    throw new Error("В отчёт попало лишнее поле.");
  }
  process.stdout.write("self-test ok\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  if (argv.includes("--self-test")) {
    selfTest();
    return 0;
  }
  knownArgs(argv);
  assertRepoAllowed(root);
  const check = argv.includes("--check");
  const purgeModules = argv.includes("--purge-modules");
  if (argv.includes("--rollback")) {
    rollback(check, purgeModules);
    return 0;
  }
  if (purgeModules) throw new Error("--purge-modules используется только вместе с --rollback.");
  const requested = lastFlag(argv, "--role");
  if (requested !== null && !["mac", "win", "wsl", "linux"].includes(requested)) {
    throw new Error(`Неизвестная роль: ${requested}`);
  }
  const role = argv.includes("--qbittorrent-only")
    ? "wsl"
    : requested ?? detectRole({ platform: process.platform, env: process.env, procVersion: procVersion() });
  if (!["mac", "win", "wsl", "linux"].includes(role)) throw new Error(`Неизвестная роль: ${role}`);
  return execute(role, { check, withPanel: argv.includes("--with-panel") });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Установка не завершилась."}\n`);
      process.exit(Number(error.exitCode) || 1);
    },
  );
}
