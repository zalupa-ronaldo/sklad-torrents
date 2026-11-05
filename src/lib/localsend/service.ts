import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { appDataDir } from "@/lib/app-data";
import { AppError } from "@/lib/app-error";
import { acceptReceivedFiles, expandSelection } from "@/lib/drive/catalog";
import {
  bindJobAbort,
  enqueueJob,
  getJob,
  insertJob,
  recoverInterruptedJobs,
  registerJobHandler,
  unbindJobAbort,
  updateJob,
} from "@/lib/jobs/queue";
import type { JobRecord } from "@/lib/jobs/types";
import { progressSnapshot } from "@/lib/jobs/types";
import { cancelTransfer, fetchPeerInfo, sha256File, transferToPeer } from "@/lib/localsend/client";
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
  fileTypeForName,
  LOCALSEND_PORT,
  normalizeFingerprint,
  PROTOCOL_VERSION,
  type DeviceInfo,
} from "@/lib/localsend/protocol";
import { loadSettings, resolveReceiveDestination, saveSettings, type LocalSendSettings } from "@/lib/localsend/settings";
import { startPeerServer, type IncomingFile, type PeerServer } from "@/lib/localsend/server";

export interface SendFilePayload {
  fileId: string;
  fileName: string;
  size: number;
  fileType: string;
  localPath: string;
  catalogPath: string;
  diskId: string;
  hostId: string;
  sent: boolean;
}

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
  const selected = await expandSelection(input.entryIds);
  if (selected.length === 0) throw new AppError(400, "Выберите файлы из каталога.");
  const files: SendFilePayload[] = [];
  for (const entry of selected) {
    if (!entry.localPath) {
      throw new AppError(400, `Нет локальной копии «${entry.path}». Склад не отмечает такую отправку как выполненную.`);
    }
    const info = await stat(entry.localPath);
    if (!info.isFile()) throw new AppError(400, `«${entry.name}» не файл.`);
    files.push({
      fileId: randomUUID(),
      fileName: entry.name,
      size: info.size,
      fileType: fileTypeForName(entry.name),
      localPath: entry.localPath,
      catalogPath: entry.path,
      diskId: entry.diskId,
      hostId: entry.hostId,
      sent: false,
    });
  }
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
      const current = await stat(file.localPath);
      if (!current.isFile() || current.size !== file.size) {
        await updateJob(job.id, {
          state: "error",
          error: `Файл «${file.fileName}» недоступен или изменился до передачи.`,
          finishedAt: Date.now(),
        });
        return;
      }
      withHash.push({ ...file, sha256: await sha256File(file.localPath), path: file.localPath });
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

async function boot(): Promise<void> {
  await recoverInterruptedJobs();
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
      const job = await insertJob({
        kind: "localsend.receive",
        idempotencyKey: `localsend.receive:${session.sessionId}`,
        title: "Приём LocalSend",
        state: "running",
        bytesTotal: total,
        payload: { sessionId: session.sessionId, files: session.files.map((file) => file.fileName) },
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
      await updateJob(jobId, {
        progress: progressSnapshot(update.fileBytes, Math.max(job.progress.bytesTotal, update.fileSize), job.startedAt, update.fileName),
      });
    },
    onFileAccepted: (file: IncomingFile) => acceptReceivedFiles([file]).then(() => undefined),
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

function sendKey(fingerprint: string, paths: string[]): string {
  const material = [normalizeFingerprint(fingerprint), ...paths.slice().sort()].join("\n");
  return `localsend.send:${createHash("sha256").update(material).digest("hex")}`;
}

registerJobHandler("localsend.send", (job) => runSendJob(job));
