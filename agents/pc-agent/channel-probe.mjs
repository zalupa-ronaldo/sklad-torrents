/**
 * Heartbeat body for the panel link (`POST /api/agent-claim` with role "channel").
 *
 * The Mac often sits behind its own router, so the PC cannot always reach the panel.
 * The panel pulls this body from `GET /v1/channel` on the job agent instead.
 *
 * Probes are read-only: one wsl.exe call for the WSL address (cached), `netsh ... show`,
 * TCP connects and one HTTP GET to qBittorrent. Nothing is started, stopped or deleted here.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const WSL_IP_TTL_MS = 60_000;
const VERSION_RE = /^v?\d+\.\d+/;

let cachedWsl = { ip: null, at: 0 };

export function channelConfig(env = process.env) {
  return {
    distro: env.SKLAD_WSL_DISTRO || "Ubuntu",
    qbUrl: env.SKLAD_CHANNEL_QB_URL || "http://127.0.0.1:8080",
    wslQbPort: Number(env.SKLAD_CHANNEL_WSL_QB_PORT || 8080),
    socatPort: Number(env.SKLAD_CHANNEL_SOCAT_PORT || 8081),
    listenPort: Number(env.SKLAD_CHANNEL_LISTEN_PORT || 18080),
    lanPort: Number(env.SKLAD_CHANNEL_LAN_PORT || 8080),
    stableBaseUrl: env.SKLAD_CHANNEL_STABLE_URL || "",
    handbrake: env.HANDBRAKE_CLI || "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
  };
}

function run(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? ""));
    });
  });
}

export function firstIpv4(text) {
  for (const token of String(text ?? "").split(/\s+/)) {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(token) && token.split(".").every((part) => Number(part) <= 255)) return token;
  }
  return null;
}

async function wslIp(cfg, now = Date.now()) {
  if (cachedWsl.ip && now - cachedWsl.at < WSL_IP_TTL_MS) return cachedWsl.ip;
  const ip = firstIpv4(await run("wsl.exe", ["-d", cfg.distro, "--", "hostname", "-I"]));
  cachedWsl = { ip, at: now };
  return ip;
}

/** Parses `netsh interface portproxy show v4tov4` into rows. */
export function parsePortproxy(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match || !/[\d.*]/.test(match[1][0])) continue;
    rows.push({ listenHost: match[1], listenPort: Number(match[2]), connectHost: match[3], connectPort: Number(match[4]) });
  }
  return rows;
}

/** A LAN entry exists for one of the channel ports and points at the current WSL address. */
export function portproxyHealthy(rows, ip, cfg) {
  if (!ip) return false;
  return rows.some(
    (row) =>
      (row.listenHost === "0.0.0.0" || row.listenHost === "*") &&
      row.connectHost === ip &&
      ((row.listenPort === cfg.lanPort && row.connectPort === cfg.socatPort) ||
        (row.listenPort === cfg.listenPort && row.connectPort === cfg.wslQbPort)),
  );
}

function tcpOpen(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function qbVersion(baseUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL("/api/v2/app/version", baseUrl);
    } catch {
      return resolve(false);
    }
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 256) body += chunk;
      });
      res.on("end", () => resolve(res.statusCode === 200 && VERSION_RE.test(body.trim())));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export async function collectChannel(env = process.env, now = Date.now()) {
  const cfg = channelConfig(env);
  if (process.platform !== "win32") {
    return {
      role: "channel",
      worker: "pc-agent",
      wslIp: null,
      socatOk: false,
      portproxyOk: false,
      qbittorrentOk: false,
      handbrakeOk: existsSync(cfg.handbrake),
    };
  }
  const ip = await wslIp(cfg, now);
  const [proxyText, socatOk, qbittorrentOk] = await Promise.all([
    run("netsh.exe", ["interface", "portproxy", "show", "v4tov4"]),
    tcpOpen(ip, cfg.socatPort),
    qbVersion(cfg.qbUrl),
  ]);
  if (!socatOk || !qbittorrentOk) cachedWsl = { ip: null, at: 0 };
  const body = {
    role: "channel",
    worker: "pc-agent",
    wslIp: ip,
    socatOk,
    portproxyOk: portproxyHealthy(parsePortproxy(proxyText), ip, cfg),
    qbittorrentOk,
    handbrakeOk: existsSync(cfg.handbrake),
  };
  if (cfg.stableBaseUrl) body.stableBaseUrl = cfg.stableBaseUrl;
  return body;
}

/**
 * Keeps the LAN forward `0.0.0.0:<listenPort>` -> `<WSL IP>:<wslQbPort>` on the current WSL address.
 * Only that one netsh row is touched; the qBittorrent :8080 chain and its watchdog stay as they are.
 * Returns what was done, for the log.
 */
export async function ensureLanForward(env = process.env) {
  if (process.platform !== "win32" || env.SKLAD_CHANNEL_MANAGE_FORWARD === "0") return "skipped";
  const cfg = channelConfig(env);
  const ip = await wslIp(cfg);
  if (!ip) return "no-wsl-ip";
  const rows = parsePortproxy(await run("netsh.exe", ["interface", "portproxy", "show", "v4tov4"]));
  const ours = rows.filter((row) => row.listenPort === cfg.listenPort);
  const good = ours.some((row) => row.listenHost === "0.0.0.0" && row.connectHost === ip && row.connectPort === cfg.wslQbPort);
  if (good && ours.length === 1) return "ok";
  for (const row of ours) {
    await run("netsh.exe", ["interface", "portproxy", "delete", "v4tov4", `listenaddress=${row.listenHost}`, `listenport=${cfg.listenPort}`]);
  }
  await run("netsh.exe", [
    "interface", "portproxy", "add", "v4tov4",
    "listenaddress=0.0.0.0", `listenport=${cfg.listenPort}`,
    `connectaddress=${ip}`, `connectport=${cfg.wslQbPort}`,
  ]);
  return `forward ${cfg.listenPort} -> ${ip}:${cfg.wslQbPort}`;
}
