import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";

import { joinCatalogPath, sanitizeRelative, type FilesystemKind, type OsKind } from "@/lib/drive/filesystem";
import {
  PROTOCOL_VERSION,
  protocolStatusMessage,
  type DeviceInfo,
  type FileMetadata,
  type LocalProtocol,
  type PrepareUploadRequest,
} from "@/lib/localsend/protocol";

const execFileAsync = promisify(execFile);

export interface ReceiveDestination {
  writeRoot: string;
  catalogRoot: string;
  os: OsKind;
  filesystem: FilesystemKind | null;
  diskId: string | null;
  hostId: string | null;
}

export interface IncomingFile {
  fileName: string;
  size: number;
  savedPath: string;
  catalogPath: string;
  os: OsKind;
  filesystem: FilesystemKind | null;
  diskId: string | null;
  hostId: string | null;
  sessionId: string;
  fileId: string;
}

export interface UploadRecord {
  sessionId: string;
  fileId: string;
  token: string;
  bytes: Buffer;
  status: number;
}

interface SessionFile {
  meta: FileMetadata;
  token: string;
  done: boolean;
  failed: boolean;
}

interface Session {
  id: string;
  remoteAddress: string;
  files: Map<string, SessionFile>;
  cancelled: boolean;
}

export interface PeerServer {
  port: number;
  protocol: LocalProtocol;
  fingerprint: string;
  info: DeviceInfo;
  prepares: PrepareUploadRequest[];
  uploads: UploadRecord[];
  cancels: string[];
  completedUploads: number;
  close: () => Promise<void>;
}

export interface PeerServerOptions {
  protocol?: LocalProtocol;
  host?: string;
  port?: number;
  alias?: string;
  deviceModel?: string | null;
  deviceType?: string | null;
  fingerprint?: string;
  certDir?: string;
  prepareStatus?: number;
  uploadStatus?: number;
  uploadDelayMs?: number;
  pin?: string;
  getPin?: () => Promise<string | undefined>;
  destination?: () => Promise<ReceiveDestination | null>;
  /** Called only after an upload body is complete, checked, and about to be acknowledged with HTTP 200. */
  onFileAccepted?: (file: IncomingFile) => Promise<void>;
  onSessionStarted?: (session: { sessionId: string; files: FileMetadata[]; remoteAddress: string }) => Promise<void>;
  onProgress?: (update: { sessionId: string; fileName: string; fileBytes: number; fileSize: number }) => Promise<void>;
  onSessionFinished?: (sessionId: string) => Promise<void>;
  onSessionFailed?: (sessionId: string, message: string) => Promise<void>;
}

export async function startPeerServer(options: PeerServerOptions = {}): Promise<PeerServer> {
  const protocol = options.protocol ?? "http";
  const alias = options.alias ?? "Склад";
  let fingerprint = options.fingerprint ?? randomBytes(16).toString("hex");
  let tls: { cert: Buffer; key: Buffer } | null = null;
  if (protocol === "https") {
    const generated = await generateCertificate(options.certDir ?? path.join(process.cwd(), "data", "localsend-cert"));
    tls = { cert: generated.cert, key: generated.key };
    fingerprint = generated.fingerprint;
  }

  const info: DeviceInfo = {
    alias,
    version: PROTOCOL_VERSION,
    deviceModel: options.deviceModel ?? "Склад",
    deviceType: options.deviceType ?? "desktop",
    fingerprint,
    protocol,
    download: false,
  };

  const state = {
    prepares: [] as PrepareUploadRequest[],
    uploads: [] as UploadRecord[],
    cancels: [] as string[],
    completedUploads: 0,
    session: null as Session | null,
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handleRequest(req, res, options, info, state).catch((error) => {
      if (!res.headersSent) respondJson(res, 500, { message: error instanceof Error ? error.message : "Unknown error" });
      else res.end();
    });
  };

  const server =
    protocol === "https" && tls
      ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, handler)
      : http.createServer(handler);

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 0;
  info.port = port;

  return {
    port,
    protocol,
    fingerprint,
    info,
    prepares: state.prepares,
    uploads: state.uploads,
    cancels: state.cancels,
    get completedUploads() {
      return state.completedUploads;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: PeerServerOptions,
  info: DeviceInfo,
  state: {
    prepares: PrepareUploadRequest[];
    uploads: UploadRecord[];
    cancels: string[];
    completedUploads: number;
    session: Session | null;
  },
): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/localsend/v2/info") {
    respondJson(res, 200, publicInfo(info));
    return;
  }
  if (req.method === "POST" && pathname === "/api/localsend/v2/register") {
    await readBody(req, 1024 * 1024);
    respondJson(res, 200, publicInfo(info));
    return;
  }
  if (req.method === "POST" && pathname === "/api/localsend/v2/prepare-upload") {
    await prepareUpload(req, res, url, options, state);
    return;
  }
  if (req.method === "POST" && pathname === "/api/localsend/v2/upload") {
    await upload(req, res, url, options, state);
    return;
  }
  if (req.method === "POST" && pathname === "/api/localsend/v2/cancel") {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!sessionId) {
      respondJson(res, 400, { message: "Missing parameters" });
      return;
    }
    state.cancels.push(sessionId);
    if (state.session?.id === sessionId) {
      state.session.cancelled = true;
      state.session = null;
      await options.onSessionFailed?.(sessionId, "Сессия отменена отправителем.");
    }
    res.writeHead(200);
    res.end();
    return;
  }
  respondJson(res, 404, { message: "Not found" });
}

async function prepareUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: PeerServerOptions,
  state: {
    prepares: PrepareUploadRequest[];
    session: Session | null;
  },
): Promise<void> {
  const requiredPin = (await options.getPin?.()) ?? options.pin;
  if (requiredPin) {
    const pin = url.searchParams.get("pin") || "";
    if (pin !== requiredPin) {
      respondJson(res, 401, { message: "PIN required / Invalid PIN" });
      return;
    }
  }
  if (state.session && !state.session.cancelled && [...state.session.files.values()].some((file) => !file.done && !file.failed)) {
    respondJson(res, 409, { message: "Blocked by another session" });
    return;
  }
  const raw = await readBody(req, 2 * 1024 * 1024);
  let parsed: PrepareUploadRequest;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as PrepareUploadRequest;
  } catch {
    respondJson(res, 400, { message: "Invalid body" });
    return;
  }
  if (!parsed || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    respondJson(res, 400, { message: "Invalid body" });
    return;
  }
  const entries = Object.values(parsed.files);
  if (entries.length === 0) {
    respondJson(res, 400, { message: "Request must contain at least one file" });
    return;
  }
  for (const file of entries) {
    if (!file || typeof file.id !== "string" || typeof file.fileName !== "string" || typeof file.size !== "number") {
      respondJson(res, 400, { message: "Invalid body" });
      return;
    }
  }
  state.prepares.push(parsed);
  if (options.prepareStatus && options.prepareStatus !== 200) {
    if (options.prepareStatus === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    respondJson(res, options.prepareStatus, { message: protocolStatusMessage(options.prepareStatus) });
    return;
  }
  const session: Session = {
    id: randomUUID(),
    remoteAddress: normalizeIp(req.socket.remoteAddress),
    files: new Map(),
    cancelled: false,
  };
  const tokens: Record<string, string> = {};
  for (const file of entries) {
    const token = randomBytes(18).toString("hex");
    session.files.set(file.id, { meta: file, token, done: false, failed: false });
    tokens[file.id] = token;
  }
  state.session = session;
  await options.onSessionStarted?.({
    sessionId: session.id,
    files: entries,
    remoteAddress: session.remoteAddress,
  });
  respondJson(res, 200, { sessionId: session.id, files: tokens });
}

async function upload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: PeerServerOptions,
  state: {
    uploads: UploadRecord[];
    completedUploads: number;
    session: Session | null;
  },
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") || "";
  const fileId = url.searchParams.get("fileId") || "";
  const token = url.searchParams.get("token") || "";
  if (!sessionId || !fileId || !token) {
    respondJson(res, 400, { message: "Missing parameters" });
    return;
  }
  const session = state.session;
  if (!session || session.id !== sessionId || session.cancelled) {
    respondJson(res, 403, { message: "Invalid token or IP address" });
    return;
  }
  if (normalizeIp(req.socket.remoteAddress) !== session.remoteAddress) {
    respondJson(res, 403, { message: "Invalid token or IP address" });
    return;
  }
  const file = session.files.get(fileId);
  if (!file || file.token !== token) {
    respondJson(res, 403, { message: "Invalid token or IP address" });
    return;
  }

  const destination = options.destination ? await options.destination() : null;
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        if (session.cancelled) {
          reject(new Error("cancelled"));
          req.destroy();
          return;
        }
        received += chunk.length;
        if (received > file.meta.size + 1024) {
          reject(new Error("too large"));
          req.destroy();
          return;
        }
        hash.update(chunk);
        chunks.push(chunk);
        void options.onProgress?.({
          sessionId,
          fileName: file.meta.fileName,
          fileBytes: received,
          fileSize: file.meta.size,
        });
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch {
    file.failed = true;
    await options.onSessionFailed?.(sessionId, "Загрузка прервана.");
    if (!res.headersSent) respondJson(res, 400, { message: "Invalid body" });
    return;
  }

  if (options.uploadDelayMs && options.uploadDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.uploadDelayMs));
  }
  if (session.cancelled || state.session?.id !== sessionId) {
    file.failed = true;
    if (!res.headersSent) respondJson(res, 409, { message: "Blocked by another session" });
    return;
  }

  const bytes = Buffer.concat(chunks);
  const failStatus = options.uploadStatus && options.uploadStatus !== 200 ? options.uploadStatus : 0;
  if (failStatus) {
    file.failed = true;
    state.uploads.push({ sessionId, fileId, token, bytes, status: failStatus });
    await options.onSessionFailed?.(sessionId, protocolStatusMessage(failStatus));
    respondJson(res, failStatus, { message: protocolStatusMessage(failStatus) });
    return;
  }
  if (received !== file.meta.size) {
    file.failed = true;
    await options.onSessionFailed?.(sessionId, "Размер файла не совпал.");
    respondJson(res, 400, { message: "Invalid body" });
    return;
  }
  if (file.meta.sha256 && hash.digest("hex") !== file.meta.sha256.toLowerCase()) {
    file.failed = true;
    await options.onSessionFailed?.(sessionId, protocolStatusMessage(422));
    respondJson(res, 422, { message: "Checksum mismatch (sha256)" });
    return;
  }

  let savedPath = "";
  let catalogPath = file.meta.fileName;
  let incoming: IncomingFile | null = null;
  if (destination) {
    try {
      const relative = sanitizeRelative(file.meta.fileName);
      catalogPath = joinCatalogPath(destination.os, destination.catalogRoot, relative);
      savedPath = localTarget(destination.writeRoot, relative);
      await mkdir(path.dirname(savedPath), { recursive: true });
      const partial = `${savedPath}.partial`;
      await writeFileBuffer(partial, bytes);
      await rename(partial, savedPath);
      incoming = {
        fileName: relative,
        size: bytes.length,
        savedPath,
        catalogPath,
        os: destination.os,
        filesystem: destination.filesystem,
        diskId: destination.diskId,
        hostId: destination.hostId,
        sessionId,
        fileId,
      };
    } catch (error) {
      file.failed = true;
      await options.onSessionFailed?.(sessionId, error instanceof Error ? error.message : "Не удалось записать файл.");
      respondJson(res, 500, { message: "Unknown error by receiver" });
      return;
    }
  }

  if (incoming && options.onFileAccepted) {
    try {
      await options.onFileAccepted(incoming);
    } catch (error) {
      file.failed = true;
      await rm(savedPath, { force: true }).catch(() => undefined);
      await options.onSessionFailed?.(sessionId, error instanceof Error ? error.message : "Индекс не принял файл.");
      respondJson(res, 500, { message: "Unknown error by receiver" });
      return;
    }
  }

  file.done = true;
  state.uploads.push({ sessionId, fileId, token, bytes, status: 200 });
  state.completedUploads += 1;
  res.writeHead(200);
  res.end();
  const allDone = [...session.files.values()].every((item) => item.done);
  if (allDone) {
    state.session = null;
    await options.onSessionFinished?.(sessionId);
  }
}

function publicInfo(info: DeviceInfo): DeviceInfo {
  return {
    alias: info.alias,
    version: info.version,
    deviceModel: info.deviceModel ?? null,
    deviceType: info.deviceType ?? "desktop",
    fingerprint: info.fingerprint,
    download: false,
  };
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeFileBuffer(file: string, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(file, { mode: 0o600 });
    stream.on("error", reject);
    stream.on("finish", () => resolve());
    stream.end(bytes);
  });
  const written = await stat(file);
  if (written.size !== bytes.length) throw new Error("Файл записан не полностью.");
}

function localTarget(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split("/"));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Имя файла выходит из каталога назначения.");
  }
  return target;
}

function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export async function generateCertificate(dir: string): Promise<{ cert: Buffer; key: Buffer; fingerprint: string }> {
  await mkdir(dir, { recursive: true });
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  try {
    const cert = await readFile(certPath);
    const key = await readFile(keyPath);
    return { cert, key, fingerprint: fingerprintOfPem(cert) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "825",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=sklad-localsend",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  return { cert, key, fingerprint: fingerprintOfPem(cert) };
}

function fingerprintOfPem(pem: Buffer): string {
  const certificate = new X509Certificate(pem);
  return createHash("sha256").update(certificate.raw).digest("hex");
}
