import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import tls from "node:tls";

import {
  normalizeFingerprint,
  protocolStatusMessage,
  type DeviceInfo,
  type FileMetadata,
  type LocalProtocol,
  type PrepareUploadRequest,
  type PrepareUploadResponse,
} from "@/lib/localsend/protocol";

export class ProtocolError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
  }
}

export interface PeerTarget {
  address: string;
  port: number;
  protocol: LocalProtocol;
  fingerprint: string;
}

export interface ProtocolResponse {
  status: number;
  body: Buffer;
  fingerprint: string | null;
}

export interface TransferFile {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
  sha256?: string | null;
  path: string;
}

export type TransferResult =
  | { ok: true; status: 200; sessionId: string; tokens: Record<string, string> }
  | { ok: false; status: number | null; sessionId: string | null; message: string; finished: boolean };

const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false, maxCachedSessions: 0 });
const httpAgent = new http.Agent({ keepAlive: false });

export async function protocolRequest(options: {
  peer: PeerTarget;
  method: "GET" | "POST";
  path: string;
  json?: unknown;
  filePath?: string;
  signal?: AbortSignal;
  /** First contact may learn a certificate. Later sends must pass the pinned fingerprint. */
  allowUnpinned?: boolean;
  onProgress?: (sent: number) => void;
  timeoutMs?: number;
}): Promise<ProtocolResponse> {
  const body = options.json === undefined ? null : Buffer.from(JSON.stringify(options.json));
  const fileSize = options.filePath ? (await stat(options.filePath)).size : null;
  const fingerprint = await new Promise<{ status: number; body: Buffer; fingerprint: string | null }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = String(body.length);
    }
    if (fileSize !== null) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(fileSize);
    }
    const transport = options.peer.protocol === "https" ? https : http;
    const req = transport.request(
      {
        host: options.peer.address,
        port: options.peer.port,
        method: options.method,
        path: options.path,
        headers,
        agent: options.peer.protocol === "https" ? httpsAgent : httpAgent,
        rejectUnauthorized: false,
        servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(options.peer.address) ? undefined : options.peer.address,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks),
            fingerprint: seenFingerprint,
          });
        });
      },
    );

    let seenFingerprint: string | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("socket", (socket: Socket) => {
      if (options.peer.protocol !== "https") return;
      const check = () => {
        try {
          seenFingerprint = certificateFingerprint(socket as tls.TLSSocket);
          const expected = normalizeFingerprint(options.peer.fingerprint);
          if (!options.allowUnpinned && expected && seenFingerprint !== expected) {
            req.destroy(
              new ProtocolError(
                "Отпечаток сертификата не совпал с сохранённым. Устройство не подменено молча — передача остановлена.",
              ),
            );
          }
        } catch (error) {
          req.destroy(error instanceof Error ? error : new ProtocolError("Сертификат получателя не прочитан."));
        }
      };
      const tlsSocket = socket as tls.TLSSocket;
      if (tlsSocket.encrypted && tlsSocket.authorized !== undefined && tlsSocket.getPeerCertificate) {
        const cert = tlsSocket.getPeerCertificate();
        if (cert && cert.raw) check();
        else tlsSocket.once("secureConnect", check);
      } else {
        socket.once("secureConnect", check);
      }
    });

    const timeout = options.timeoutMs ?? (options.filePath ? 0 : 8000);
    if (timeout > 0) {
      req.setTimeout(timeout, () => {
        req.destroy(new ProtocolError("Таймаут LocalSend. Устройство в сети не ответило."));
      });
    }

    const onAbort = () => req.destroy(abortError());
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }

    req.on("error", (error) => {
      if (options.signal?.aborted) fail(abortError());
      else fail(error instanceof ProtocolError ? error : new ProtocolError(error.message));
    });

    if (options.filePath) {
      const stream = createReadStream(options.filePath);
      let sent = 0;
      stream.on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        sent += buffer.length;
        options.onProgress?.(sent);
        if (!req.write(buffer)) stream.pause();
      });
      req.on("drain", () => stream.resume());
      stream.on("end", () => req.end());
      stream.on("error", (error) => {
        req.destroy(error);
      });
      return;
    }

    if (body) req.end(body);
    else req.end();
  });

  if (options.peer.protocol === "https" && !options.allowUnpinned) {
    const expected = normalizeFingerprint(options.peer.fingerprint);
    if (!fingerprint.fingerprint || fingerprint.fingerprint !== expected) {
      throw new ProtocolError(
        "Отпечаток сертификата не совпал с сохранённым. Устройство не подменено молча — передача остановлена.",
      );
    }
  }
  return fingerprint;
}

export async function fetchPeerInfo(peer: PeerTarget, signal?: AbortSignal, allowUnpinned = false): Promise<DeviceInfo & { certificateFingerprint: string | null }> {
  const response = await protocolRequest({
    peer,
    method: "GET",
    path: "/api/localsend/v2/info",
    signal,
    allowUnpinned,
  });
  if (response.status !== 200) {
    throw new ProtocolError(`GET /api/localsend/v2/info: ${protocolStatusMessage(response.status)}`, response.status);
  }
  const info = parseDevice(response.body);
  return { ...info, certificateFingerprint: response.fingerprint };
}

export async function registerWithPeer(peer: PeerTarget, self: DeviceInfo, allowUnpinned = false): Promise<DeviceInfo & { certificateFingerprint: string | null }> {
  const response = await protocolRequest({
    peer,
    method: "POST",
    path: "/api/localsend/v2/register",
    json: self,
    allowUnpinned,
  });
  if (response.status !== 200) {
    throw new ProtocolError(`POST /api/localsend/v2/register: ${protocolStatusMessage(response.status)}`, response.status);
  }
  return { ...parseDevice(response.body), certificateFingerprint: response.fingerprint };
}

export async function cancelTransfer(peer: PeerTarget, sessionId: string, signal?: AbortSignal): Promise<number> {
  const response = await protocolRequest({
    peer,
    method: "POST",
    path: `/api/localsend/v2/cancel?${new URLSearchParams({ sessionId }).toString()}`,
    signal,
    timeoutMs: 8000,
  });
  return response.status;
}

/**
 * Speaks prepare-upload and upload. `ok` is true only after prepare-upload
 * returned HTTP 200 and every accepted file's upload returned HTTP 200.
 */
export async function transferToPeer(options: {
  peer: PeerTarget;
  sender: DeviceInfo;
  files: TransferFile[];
  pin?: string | null;
  signal?: AbortSignal;
  onSession?: (sessionId: string) => Promise<void> | void;
  onFileStart?: (file: TransferFile) => Promise<void> | void;
  onProgress?: (file: TransferFile, sent: number) => Promise<void> | void;
  onFileDone?: (file: TransferFile) => Promise<void> | void;
}): Promise<TransferResult> {
  if (options.files.length === 0) {
    return { ok: false, status: null, sessionId: null, message: "Нет файлов для отправки.", finished: false };
  }
  const files: Record<string, FileMetadata> = {};
  for (const file of options.files) {
    files[file.id] = {
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      fileType: file.fileType,
      sha256: file.sha256 ?? null,
      preview: null,
    };
  }
  const request: PrepareUploadRequest = { info: options.sender, files };
  const pin = options.pin?.trim();
  const preparePath = pin
    ? `/api/localsend/v2/prepare-upload?${new URLSearchParams({ pin }).toString()}`
    : "/api/localsend/v2/prepare-upload";

  let prepare: ProtocolResponse;
  try {
    prepare = await protocolRequest({
      peer: options.peer,
      method: "POST",
      path: preparePath,
      json: request,
      signal: options.signal,
    });
  } catch (error) {
    return failure(error, null);
  }

  if (prepare.status === 204) {
    return {
      ok: false,
      status: 204,
      sessionId: null,
      message: protocolStatusMessage(204),
      finished: true,
    };
  }
  if (prepare.status !== 200) {
    return {
      ok: false,
      status: prepare.status,
      sessionId: null,
      message: `prepare-upload: ${messageFrom(prepare)}`,
      finished: false,
    };
  }

  let parsed: PrepareUploadResponse;
  try {
    parsed = JSON.parse(prepare.body.toString("utf8")) as PrepareUploadResponse;
  } catch {
    return { ok: false, status: 200, sessionId: null, message: "prepare-upload вернул не JSON.", finished: false };
  }
  if (!parsed.sessionId || typeof parsed.sessionId !== "string") {
    return { ok: false, status: 200, sessionId: null, message: "prepare-upload не вернул sessionId.", finished: false };
  }
  const tokens: Record<string, string> = {};
  for (const [fileId, token] of Object.entries(parsed.files ?? {})) {
    if (typeof token === "string" && token) tokens[fileId] = token;
  }
  const missing = options.files.filter((file) => !tokens[file.id]);
  if (missing.length > 0) {
    await cancelTransfer(options.peer, parsed.sessionId).catch(() => undefined);
    return {
      ok: false,
      status: 200,
      sessionId: parsed.sessionId,
      message: `Получатель не выдал token для: ${missing.map((file) => file.fileName).join(", ")}.`,
      finished: false,
    };
  }
  await options.onSession?.(parsed.sessionId);

  for (const file of options.files) {
    if (options.signal?.aborted) return failure(abortError(), parsed.sessionId);
    await options.onFileStart?.(file);
    let upload: ProtocolResponse;
    try {
      upload = await protocolRequest({
        peer: options.peer,
        method: "POST",
        path: `/api/localsend/v2/upload?${new URLSearchParams({
          sessionId: parsed.sessionId,
          fileId: file.id,
          token: tokens[file.id],
        }).toString()}`,
        filePath: file.path,
        signal: options.signal,
        timeoutMs: 0,
        onProgress: (sent) => {
          void options.onProgress?.(file, sent);
        },
      });
    } catch (error) {
      return failure(error, parsed.sessionId);
    }
    if (upload.status !== 200) {
      return {
        ok: false,
        status: upload.status,
        sessionId: parsed.sessionId,
        message: `upload ${file.fileName}: ${messageFrom(upload)}`,
        finished: false,
      };
    }
    await options.onFileDone?.(file);
  }

  return { ok: true, status: 200, sessionId: parsed.sessionId, tokens };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function certificateFingerprint(socket: tls.TLSSocket): string {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.raw) throw new ProtocolError("Сертификат получателя не получен.");
  return createHash("sha256").update(cert.raw).digest("hex");
}

function parseDevice(body: Buffer): DeviceInfo {
  const parsed = JSON.parse(body.toString("utf8")) as DeviceInfo;
  if (!parsed || typeof parsed.alias !== "string" || typeof parsed.fingerprint !== "string") {
    throw new ProtocolError("Ответ LocalSend без alias или fingerprint.");
  }
  return parsed;
}

function messageFrom(response: ProtocolResponse): string {
  const text = response.body.toString("utf8").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) return `${protocolStatusMessage(response.status)}: ${parsed.message}`;
    } catch {
      return `${protocolStatusMessage(response.status)}: ${text.slice(0, 180)}`;
    }
  }
  return protocolStatusMessage(response.status);
}

function failure(error: unknown, sessionId: string | null): TransferResult {
  if (error instanceof ProtocolError) {
    return { ok: false, status: error.status, sessionId, message: error.message, finished: false };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, status: null, sessionId, message: error.message, finished: false };
  }
  return {
    ok: false,
    status: null,
    sessionId,
    message: error instanceof Error ? error.message : "Ошибка протокола LocalSend.",
    finished: false,
  };
}

function abortError(): Error {
  const error = new Error("Передача прервана.");
  error.name = "AbortError";
  return error;
}
