import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { appDataDir } from "@/lib/app-data";
import { AppError } from "@/lib/app-error";
import { acceptReceivedFiles } from "@/lib/drive/catalog";
import {
  bindJobAbort,
  enqueueJob,
  getJob,
  insertJob,
  listJobs,
  recoverInterruptedJobs,
  registerJobHandler,
  resumeQueue,
  unbindJobAbort,
  updateJob,
} from "@/lib/jobs/queue";
import type { JobRecord } from "@/lib/jobs/types";
import { progressSnapshot } from "@/lib/jobs/types";
import { cancelTransfer, fetchPeerInfo, sha256File, sha256Stream, transferToPeer } from "@/lib/localsend/client";
import {
  addDeviceByIp,
  discoveryError,
  getDevice,
  listDevices,
  loadManualDevices,
  removeDevice,
  setDiscoveryError,
  startMulticast,
  upsertDevice,
  type DiscoveredDevice,
} from "@/lib/localsend/discovery";
import {
  LOCALSEND_PORT,
  normalizeFingerprint,
  PROTOCOL_VERSION,
  type DeviceInfo,
} from "@/lib/localsend/protocol";
import { machineLabel } from "@/lib/localsend/paths";
import { openAgentFile } from "@/lib/localsend/remote";
import { loadSettings, resolveReceiveDestination, saveSettings, type LocalSendSettings } from "@/lib/localsend/settings";
import { collectSendFiles, type SendFilePayload } from "@/lib/localsend/sources";
import { registerLocalsendProgress } from "@/lib/localsend/progress";
import { startPeerServer, type IncomingFile, type PeerServer } from "@/lib/localsend/server";

export type { SendFilePayload };

export interface SendPayload {
  peer: {
    alias: string;
    address: string;
    port: number;
    protocol: "http" | "https";
    fingerprint: string;
    demo: boolean;
  };
  files: SendFilePayload[];
  pin: string | null;
  hostLabel: string;
}

interface ReceivePayload {
  sessionId: string;
  hostLabel: string;
  files: { fileId: string; fileName: string; size: number; sha256: string | null }[];
}

interface Runtime {
  boot: Promise<void> | null;
  self: DeviceInfo | null;
  receive: PeerServer | null;
  mock: PeerServer | null;
  receiveJobs: Map<string, string>;
  progressAt: Map<string, number>;
}

function runtime(): Runtime {
  const g = globalThis as { __skladLocalsend?: Runtime };
  if (!g.__skladLocalsend) {
    g.__skladLocalsend = {
      boot: null,
      self: null,
      receive: null,
      mock: null,
      receiveJobs: new Map(),
      progressAt: new Map(),
    };
  }
  return g.__skladLocalsend;
}

export function ensureLocalsend(): Promise<void> {
  const state = runtime();
  if (!state.boot) state.boot = boot().catch((error) => {
    state.boot = null;
    setDiscoveryError(error instanceof Error ? error.message : "LocalSend не запустился.");
    throw error;
  });
  return state.boot;
}

export async function localsendStatus(): Promise<{
  devices: DiscoveredDevice[];
  lastError: string | null;
  mock: boolean;
  self: DeviceInfo | null;
}> {
  await refreshMock();
  return {
    devices: listDevices(),
    lastError: discoveryError(),
    mock: process.env.LOCALSEND_MOCK === "1",
    self: runtime().self,
  };
}

export async function saveLocalsendSettings(input: Partial<LocalSendSettings>): Promise<LocalSendSettings> {
  const saved = await saveSettings(input);
  const self = runtime().self;
  const receive = runtime().receive;
  if (self) self.alias = saved.alias;
  if (receive) receive.info.alias = saved.alias;
  return saved;
}

export async function addManualDevice(address: string, port = LOCALSEND_PORT): Promise<DiscoveredDevice> {
  const self = runtime().self ?? fallbackSelf();
  return addDeviceByIp(address, port, self);
}

export async function enqueueSend(input: {
  fingerprint: string;
  entryIds: string[];
  driveFiles?: { diskId: string; path: string; name: string; kind?: string }[];
  pin?: string;
}): Promise<{ job: JobRecord<SendPayload>; duplicate: boolean }> {
  await refreshMock();
  const device = getDevice(input.fingerprint);
  if (!device) {
    throw new AppError(404, "Устройство LocalSend не найдено. Обновите поиск или добавьте его по IP.");
  }
  if (device.demo && !runtime().mock) {
    throw new AppError(409, "Демо-получатель не запущен. Отправка не создана.");
  }
  const files = await collectSendFiles(
    input.entryIds,
    (input.driveFiles ?? []).map((file) => ({
      diskId: file.diskId,
      path: file.path,
      name: file.name,
      kind: file.kind,
    })),
  );
  const hostLabel = [...new Set(files.map((file) => file.hostLabel))].join(" · ") || "эта машина";
  const payload: SendPayload = {
    peer: {
      alias: device.alias,
      address: device.address,
      port: device.port,
      protocol: device.protocol,
      fingerprint: device.fingerprint,
      demo: device.demo,
    },
    files,
    pin: input.pin?.trim() || null,
    hostLabel,
  };
  return enqueueJob({
    kind: "localsend.send",
    idempotencyKey: sendKey(device.fingerprint, files.map((file) => file.catalogPath)),
    title: `LocalSend → ${device.alias}`,
    payload,
    bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
  });
}

async function runSendJob(job: JobRecord): Promise<void> {
  const payload = job.payload as SendPayload;
  const controller = new AbortController();
  bindJobAbort(job.id, controller);
  let sessionId: string | null = job.sessionId;
  try {
    const pending = payload.files.filter((file) => !file.sent);
    const total = payload.files.reduce((sum, file) => sum + file.size, 0);
    const already = total - pending.reduce((sum, file) => sum + file.size, 0);
    const startedAt = job.startedAt ?? Date.now();
    await updateJob(job.id, {
      state: "running",
      startedAt,
      error: null,
      progress: progressSnapshot(already, total, startedAt, pending[0]?.fileName ?? null),
    });
    if (pending.length === 0) {
      await updateJob(job.id, {
        state: "done",
        finishedAt: Date.now(),
        progress: progressSnapshot(total, total, startedAt, null),
      });
      return;
    }
    if (await stopped(job.id, sessionId, payload, controller)) return;

    const peer = {
      address: payload.peer.address,
      port: payload.peer.port,
      protocol: payload.peer.protocol,
      fingerprint: payload.peer.fingerprint,
    };
    try {
      const info = await fetchPeerInfo(peer, controller.signal, false);
      if (peer.protocol === "http" && normalizeFingerprint(info.fingerprint) !== normalizeFingerprint(peer.fingerprint)) {
        await updateJob(job.id, {
          state: "error",
          error: "Отпечаток устройства изменился. Отправка остановлена, чтобы получателя не подменили.",
          finishedAt: Date.now(),
        });
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await stopped(job.id, sessionId, payload, controller);
        return;
      }
      await updateJob(job.id, {
        state: "error",
        error: error instanceof Error ? error.message : "Устройство LocalSend не ответило.",
        finishedAt: Date.now(),
      });
      return;
    }

    const withHash = [];
    for (const file of pending) {
      const sha256 = await hashSendFile(file, controller.signal);
      if (sha256 == null) {
        await updateJob(job.id, {
          state: "error",
          error: `Файл «${file.fileName}» недоступен или изменился до передачи. Оригинал не удалялся.`,
          finishedAt: Date.now(),
        });
        return;
      }
      file.sha256 = sha256;
      await updateJob(job.id, { payload });
      withHash.push({
        id: file.fileId,
        fileName: file.fileName,
        size: file.size,
        fileType: file.fileType,
        sha256,
        path: file.localPath || "",
        open: file.remote ? () => openAgentFile(file.remote!, controller.signal) : undefined,
      });
    }

    let sentBytes = already;
    let lastUi = 0;
    const result = await transferToPeer({
      peer,
      sender: runtime().self ?? fallbackSelf(),
      files: withHash,
      pin: payload.pin,
      signal: controller.signal,
      onSession: async (id) => {
        sessionId = id;
        await updateJob(job.id, { sessionId: id });
      },
      onFileStart: async (file) => {
        await updateJob(job.id, { progress: progressSnapshot(sentBytes, total, startedAt, file.fileName) });
      },
      onProgress: async (file, sent) => {
        const now = Date.now();
        if (now - lastUi < 150 && sent < file.size) return;
        lastUi = now;
        await updateJob(job.id, { progress: progressSnapshot(sentBytes + sent, total, startedAt, file.fileName) });
      },
      onFileDone: async (file) => {
        const stored = payload.files.find((item) => item.fileId === file.id);
        if (stored && !stored.sent) {
          stored.sent = true;
          sentBytes += stored.size;
        }
        await updateJob(job.id, {
          payload,
          progress: progressSnapshot(sentBytes, total, startedAt, null),
        });
      },
    });

    if (result.ok) {
      await updateJob(job.id, {
        state: "done",
        error: null,
        note: null,
        sessionId: result.sessionId,
        finishedAt: Date.now(),
        progress: progressSnapshot(total, total, startedAt, null),
      });
      return;
    }
    if (controller.signal.aborted) {
      await stopped(job.id, result.sessionId ?? sessionId, payload, controller);
      return;
    }
    if (result.sessionId) {
      await cancelTransfer(peer, result.sessionId).catch(() => undefined);
    }
    if (result.finished && result.status === 204) {
      await updateJob(job.id, {
        state: "done",
        error: null,
        note: "Получатель ответил 204 Finished: передавать файлы не нужно. Байты не отправлялись.",
        sessionId: result.sessionId,
        finishedAt: Date.now(),
      });
      return;
    }
    await updateJob(job.id, {
      state: "error",
      error: result.message,
      sessionId: result.sessionId,
      finishedAt: Date.now(),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      await stopped(job.id, sessionId, payload, controller);
      return;
    }
    await updateJob(job.id, {
      state: "error",
      error: error instanceof Error ? error.message : "Ошибка передачи LocalSend.",
      finishedAt: Date.now(),
    });
  } finally {
    unbindJobAbort(job.id);
  }
}

async function stopped(
  jobId: string,
  sessionId: string | null,
  payload: SendPayload,
  controller: AbortController,
): Promise<boolean> {
  if (!controller.signal.aborted) {
    const current = await getJob(jobId);
    if (current?.control !== "pause" && current?.control !== "cancel") return false;
  }
  const current = await getJob(jobId);
  const control = current?.control;
  const peer = {
    address: payload.peer.address,
    port: payload.peer.port,
    protocol: payload.peer.protocol,
    fingerprint: payload.peer.fingerprint,
  };
  if (!sessionId) {
    await updateJob(jobId, {
      state: "error",
      error: "Остановлено до sessionId. Маршрут /api/localsend/v2/cancel не вызывался.",
      control: null,
      finishedAt: Date.now(),
    });
    return true;
  }
  try {
    const status = await cancelTransfer(peer, sessionId);
    if (status < 200 || status >= 300) {
      await updateJob(jobId, {
        state: "error",
        error: `Cancel вернул HTTP ${status}. Пауза не подтверждена протоколом.`,
        control: null,
        finishedAt: Date.now(),
      });
      return true;
    }
  } catch (error) {
    await updateJob(jobId, {
      state: "error",
      error: error instanceof Error ? error.message : "Cancel не выполнился.",
      control: null,
      finishedAt: Date.now(),
    });
    return true;
  }
  if (control === "pause") {
    await updateJob(jobId, { state: "paused", error: null, control: null, sessionId: null, payload });
    return true;
  }
  await updateJob(jobId, {
    state: "error",
    error: "Отменено. Получатель подтвердил /api/localsend/v2/cancel.",
    control: null,
    finishedAt: Date.now(),
  });
  return true;
}

export async function restoreLocalsendAfterRestart(): Promise<number> {
  const jobs = await listJobs();
  let restored = 0;
  for (const job of jobs) {
    if (!job.kind.startsWith("localsend.")) continue;
    if (job.state !== "error" || !/перезапуск/i.test(job.error || "")) continue;
    await updateJob(job.id, {
      state: "paused",
      error: null,
      finishedAt: null,
      control: null,
      note: "Пауза после перезапуска. Уже отправленные файлы не отправляются снова, исходные файлы на месте.",
    });
    restored += 1;
  }
  return restored;
}

async function boot(): Promise<void> {
  await recoverInterruptedJobs();
  await restoreLocalsendAfterRestart();
  await loadManualDevices();
  const settings = await loadSettings();
  const destination = await resolveReceiveDestination(settings);
  if (destination.writeRoot.startsWith("/") || process.platform === "win32") {
    await import("node:fs/promises").then((fs) => fs.mkdir(destination.writeRoot, { recursive: true }).catch(() => undefined));
  }
  try {
    await listen(settings, LOCALSEND_PORT);
  } catch (error) {
    setDiscoveryError(
      `Порт ${LOCALSEND_PORT} занят (${error instanceof Error ? error.message : "ошибка"}). Приём запущен на другом порту, это уже не стандартный LocalSend.`,
    );
    await listen(settings, 0);
  }
  if (runtime().self) startMulticast(() => runtime().self ?? fallbackSelf());
  registerLocalsendProgress();
  resumeQueue();
  if (process.env.LOCALSEND_MOCK === "1") {
    try {
      const mock = await startPeerServer({
        protocol: "https",
        host: "127.0.0.1",
        port: 0,
        alias: "Демо LocalSend",
        deviceModel: "mock",
        deviceType: "headless",
        certDir: path.join(appDataDir(), "localsend-mock"),
        uploadDelayMs: 700,
      });
      runtime().mock = mock;
      await refreshMock();
    } catch (error) {
      runtime().mock = null;
      setDiscoveryError(
        `Демо-получатель не запустился (${error instanceof Error ? error.message : "ошибка"}). Пока он молчит, отправка ему не будет «готовой».`,
      );
    }
  }
}

async function listen(settings: LocalSendSettings, port: number): Promise<void> {
  const receive = await startPeerServer({
    protocol: "https",
    host: "0.0.0.0",
    port,
    alias: settings.alias,
    deviceModel: "Склад",
    deviceType: "desktop",
    certDir: path.join(appDataDir(), "localsend-self"),
    getPin: async () => {
      const pin = (await loadSettings()).receivePin;
      return pin || undefined;
    },
    destination: () => resolveReceiveDestination(),
    onSessionStarted: async (session) => {
      const total = session.files.reduce((sum, file) => sum + file.size, 0);
      const destination = await resolveReceiveDestination().catch(() => null);
      const hostLabel = destination
        ? machineLabel({ os: destination.os, path: destination.catalogRoot })
        : "эта машина";
      const payload: ReceivePayload = {
        sessionId: session.sessionId,
        hostLabel,
        files: session.files.map((file) => ({
          fileId: file.id,
          fileName: file.fileName,
          size: file.size,
          sha256: null,
        })),
      };
      const job = await insertJob({
        kind: "localsend.receive",
        idempotencyKey: `localsend.receive:${session.sessionId}`,
        title: "Приём LocalSend",
        state: "running",
        bytesTotal: total,
        payload,
      });
      runtime().receiveJobs.set(session.sessionId, job.id);
      await updateJob(job.id, {
        sessionId: session.sessionId,
        progress: progressSnapshot(0, total, job.startedAt, session.files[0]?.fileName ?? null),
      });
    },
    onProgress: async (update) => {
      const jobId = runtime().receiveJobs.get(update.sessionId);
      if (!jobId) return;
      const now = Date.now();
      const previous = runtime().progressAt.get(jobId) ?? 0;
      if (now - previous < 150 && update.fileBytes < update.fileSize) return;
      runtime().progressAt.set(jobId, now);
      const job = await getJob(jobId);
      if (!job || job.state !== "running") return;
      const total = update.sessionTotal || job.progress.bytesTotal;
      await updateJob(jobId, {
        progress: progressSnapshot(update.sessionBytes, Math.max(total, update.sessionBytes), job.startedAt, update.fileName),
      });
    },
    onFileAccepted: async (file: IncomingFile) => {
      await acceptReceivedFiles([file]);
      const { appendReceivedFiles } = await import("@/addons/drives/service");
      await appendReceivedFiles({
        diskId: file.diskId,
        relativePath: file.fileName,
        size: file.size,
        os: file.os,
        catalogPath: file.catalogPath,
      });
      const jobId = runtime().receiveJobs.get(file.sessionId);
      if (!jobId) return;
      const job = await getJob(jobId);
      if (!job) return;
      const payload = job.payload as ReceivePayload;
      const match = payload.files?.find((item) => item.fileId === file.fileId);
      if (match) match.sha256 = file.sha256;
      await updateJob(jobId, { payload });
    },
    onSessionFinished: async (sessionId) => {
      const jobId = runtime().receiveJobs.get(sessionId);
      if (!jobId) return;
      const job = await getJob(jobId);
      if (!job || job.state !== "running") return;
      await updateJob(jobId, {
        state: "done",
        error: null,
        finishedAt: Date.now(),
        progress: progressSnapshot(job.progress.bytesTotal, job.progress.bytesTotal, job.startedAt, null),
      });
    },
    onSessionFailed: async (sessionId, message) => {
      const jobId = runtime().receiveJobs.get(sessionId);
      if (!jobId) return;
      const job = await getJob(jobId);
      if (!job || job.state === "done" || job.state === "error") return;
      await updateJob(jobId, { state: "error", error: message, finishedAt: Date.now() });
    },
  });
  runtime().receive = receive;
  runtime().self = {
    ...receive.info,
    fingerprint: receive.fingerprint,
    port: receive.port,
    protocol: "https",
    download: false,
  };
}

async function refreshMock(): Promise<void> {
  const mock = runtime().mock;
  if (process.env.LOCALSEND_MOCK !== "1" || !mock) {
    for (const device of listDevices()) {
      if (device.source === "mock") removeDevice(device.fingerprint);
    }
    if (process.env.LOCALSEND_MOCK === "1" && !mock) {
      setDiscoveryError("Демо-получатель не запущен. Отправка ему не будет отмечена как успешная.");
    }
    return;
  }
  try {
    await fetchPeerInfo(
      { address: "127.0.0.1", port: mock.port, protocol: mock.protocol, fingerprint: mock.fingerprint },
      undefined,
      false,
    );
    upsertDevice({
      alias: "Демо LocalSend",
      address: "127.0.0.1",
      port: mock.port,
      protocol: mock.protocol,
      fingerprint: mock.fingerprint,
      deviceModel: "mock",
      deviceType: "headless",
      version: PROTOCOL_VERSION,
      demo: true,
      source: "mock",
      lastSeen: Date.now(),
    });
  } catch (error) {
    removeDevice(mock.fingerprint);
    setDiscoveryError(
      `Демо-получатель не отвечает (${error instanceof Error ? error.message : "нет связи"}). Пока сервер молчит, передача не считается успешной.`,
    );
  }
}

function fallbackSelf(): DeviceInfo {
  return {
    alias: "Склад",
    version: PROTOCOL_VERSION,
    deviceModel: "Склад",
    deviceType: "desktop",
    fingerprint: "sklad-sender",
    port: LOCALSEND_PORT,
    protocol: "http",
    download: false,
  };
}

async function hashSendFile(file: SendFilePayload, signal: AbortSignal): Promise<string | null> {
  if (file.localPath) {
    try {
      const current = await stat(file.localPath);
      if (!current.isFile() || current.size !== file.size) return null;
    } catch {
      return null;
    }
    return sha256File(file.localPath);
  }
  const remote = file.remote;
  if (!remote) return null;
  const hashed = await sha256Stream(() => openAgentFile(remote, signal));
  if (hashed.size !== file.size) return null;
  return hashed.sha256;
}

function sendKey(fingerprint: string, paths: string[]): string {
  const material = [normalizeFingerprint(fingerprint), ...paths.slice().sort()].join("\n");
  return `localsend.send:${createHash("sha256").update(material).digest("hex")}`;
}

registerJobHandler("localsend.send", (job) => runSendJob(job));
