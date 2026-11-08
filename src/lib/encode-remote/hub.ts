import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

import { createJobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";
import { dataDir } from "@/lib/qbittorrent/store";
import { assignEncodeJobs, type EncodeCodec } from "@/lib/transcode/assign";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";

const CHUNK = 64 * 1024;

interface WorkerInfo {
  id: string;
  role: "pc" | "mac";
  encoders: string[];
  slots: number;
  freeBytes: number;
  lastSeen: number;
  busy: number;
}

interface Lease {
  jobId: string;
  workerId: string;
  token: string;
  revision: number;
  expiresAt: number;
  sourceSha: string;
  received: number;
  codec: EncodeCodec;
}

export async function startEncodeHub(input: { token: string; port?: number; bind?: string; directory?: string }): Promise<{ port: number; bound: string; close: () => Promise<void> }> {
  if (input.token.length < 16) throw new Error("Нужен токен воркера длиной от 16 символов. Он не пишется в журнал.");
  const bind = input.bind || "127.0.0.1";
  if (!isLoopback(bind) && process.env.SKLAD_ENCODE_ALLOW_LAN !== "1") {
    throw new Error("Без явного SKLAD_ENCODE_ALLOW_LAN хаб слушает только 127.0.0.1. LAN не включён.");
  }
  const directory = input.directory ?? dataDir();
  const workers = new Map<string, WorkerInfo>();
  const leases = new Map<string, Lease>();
  const leaseMs = Number(process.env.SKLAD_LEASE_MS || 15_000);
  const server = createServer((req, res) => {
    void handle(req, res, { token: input.token, directory, workers, leases, leaseMs }).catch(() => send(res, 500, { error: "failed" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, bind, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await writeFile(path.join(directory, "hub.json"), JSON.stringify({ port, bound: bind }), "utf8");
  return {
    port,
    bound: bind,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: { token: string; directory: string; workers: Map<string, WorkerInfo>; leases: Map<string, Lease>; leaseMs: number }): Promise<void> {
  if (!bearer(req.headers.authorization, ctx.token)) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "POST" && url.pathname === "/v1/workers") {
    const body = await jsonBody(req);
    const worker = readWorker(body);
    if (!worker) {
      send(res, 400, { error: "Нужны id, role, encoders и slots." });
      return;
    }
    ctx.workers.set(worker.id, { ...worker, lastSeen: Date.now(), busy: ctx.workers.get(worker.id)?.busy ?? 0 });
    send(res, 200, { ok: true, id: worker.id });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/workers/heartbeat") {
    const body = await jsonBody(req);
    const id = typeof body.id === "string" ? body.id : "";
    const worker = ctx.workers.get(id);
    if (!worker) {
      send(res, 404, { error: "Воркер не зарегистрирован." });
      return;
    }
    worker.lastSeen = Date.now();
    if (typeof body.freeBytes === "number") worker.freeBytes = body.freeBytes;
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/jobs/claim") {
    const body = await jsonBody(req);
    const id = typeof body.id === "string" ? body.id : "";
    const worker = fresh(ctx.workers, id);
    if (!worker) {
      send(res, 404, { error: "Воркер не на связи." });
      return;
    }
    await expireLeases(ctx);
    if (worker.busy >= worker.slots) {
      send(res, 200, { job: null, reason: "Слот занят." });
      return;
    }
    const store = createJobStore(ctx.directory);
    const queued = await store.list({ limit: 100 });
    const open = queued.jobs.find((job) => job.kind === "transcode" && job.state === "queued" && fits(worker, job));
    if (!open) {
      send(res, 200, { job: null });
      return;
    }
    const codec = codecOf(open.payload.handbrakeProfile);
    if (!codec) {
      send(res, 200, { job: null, reason: "Профиль не из настроенного пресета." });
      return;
    }
    let claimedToken = "";
    try {
      assertEncodePaths([open.payload.source, open.payload.destination]);
    } catch (error) {
      await store.cancel(open.id).catch(() => undefined);
      send(res, 200, { job: null, reason: error instanceof Error ? error.message : "Путь закрыт." });
      return;
    }
    const claim = await store.claim(open.id, "linux-local");
    if (!claim.ok || !claim.job.workerToken) {
      send(res, 200, { job: null });
      return;
    }
    claimedToken = claim.job.workerToken;
    const info = await stat(open.payload.source);
    if (info.size <= 0 || info.size > 8 * 1024 * 1024 || worker.freeBytes < info.size * 3) {
      await store.fail(open.id, claimedToken, "Файл больше бюджета воркера или пустой.");
      send(res, 200, { job: null, reason: "Файл вне бюджета." });
      return;
    }
    const sourceSha = await shaFile(open.payload.source);
    const revision = (ctx.leases.get(open.id)?.revision ?? 0) + 1;
    const lease: Lease = {
      jobId: open.id,
      workerId: worker.id,
      token: claimedToken,
      revision,
      expiresAt: Date.now() + ctx.leaseMs,
      sourceSha,
      received: 0,
      codec,
    };
    ctx.leases.set(open.id, lease);
    worker.busy += 1;
    await mkdir(path.join(ctx.directory, "remote-incoming"), { recursive: true });
    send(res, 200, { job: { jobId: open.id, lease: lease.token, revision, codec, bytes: info.size, sourceSha256: sourceSha } });
    return;
  }
  const jobId = parts[2] || "";
  if (!/^job_[0-9a-f-]+$/i.test(jobId)) {
    send(res, 404, { error: "Нет такого задания." });
    return;
  }
  const lease = ctx.leases.get(jobId);
  const presented = header(req, "x-lease");
  if (!lease || presented !== lease.token || Date.now() > lease.expiresAt) {
    send(res, 409, { error: "Lease нет или он истёк. Повторная сдача не принимается." });
    return;
  }
  if (req.method === "POST" && parts[3] === "heartbeat") {
    lease.expiresAt = Date.now() + ctx.leaseMs;
    const owner = ctx.workers.get(lease.workerId);
    if (owner) owner.lastSeen = Date.now();
    send(res, 200, { ok: true, revision: lease.revision });
    return;
  }
  if (req.method === "GET" && parts[3] === "input") {
    const job = await jobOf(ctx.directory, jobId);
    if (!job) {
      send(res, 404, { error: "Нет такого задания." });
      return;
    }
    const offset = Number(url.searchParams.get("offset") || 0);
    const length = Math.min(CHUNK, Number(url.searchParams.get("length") || CHUNK));
    const size = (await stat(job.payload.source)).size;
    if (!Number.isInteger(offset) || offset < 0 || offset > size || !Number.isInteger(length) || length <= 0) {
      send(res, 400, { error: "Неверный диапазон." });
      return;
    }
    const take = Math.min(length, size - offset);
    const bytes = await readSlice(job.payload.source, offset, take);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex"),
      "cache-control": "no-store",
    });
    res.end(bytes);
    return;
  }
  if (req.method === "PUT" && parts[3] === "output") {
    const offset = Number(url.searchParams.get("offset"));
    const announced = header(req, "x-chunk-sha256");
    const bytes = await binaryBody(req);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!announced || announced !== actual) {
      send(res, 400, { error: "Хэш куска не сошёлся. Кусок не записан." });
      return;
    }
    if (offset !== lease.received) {
      send(res, 409, { error: "Кусок не продолжает уже принятые байты.", received: lease.received });
      return;
    }
    const file = incoming(ctx.directory, jobId);
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, offset === 0 ? "w" : "r+");
    await handle.write(bytes, 0, bytes.length, offset);
    await handle.close();
    lease.received += bytes.length;
    lease.expiresAt = Date.now() + ctx.leaseMs;
    send(res, 200, { ok: true, received: lease.received });
    return;
  }
  if (req.method === "POST" && parts[3] === "finish") {
    const body = await jsonBody(req);
    const revision = Number(body.revision);
    const outputSha = typeof body.outputSha256 === "string" ? body.outputSha256 : "";
    if (revision !== lease.revision) {
      send(res, 409, { error: "Ревизия задания устарела.", verified: false });
      return;
    }
    const job = await jobOf(ctx.directory, jobId);
    if (!job || job.state !== "running") {
      send(res, 409, { error: "Задание уже сдано. Второй результат не записывается.", verified: false });
      return;
    }
    const currentSource = await shaFile(job.payload.source);
    if (currentSource !== lease.sourceSha) {
      await failJob(ctx, lease, "Источник изменился. Результат не принят.");
      send(res, 409, { error: "Источник изменился.", verified: false });
      return;
    }
    const file = incoming(ctx.directory, jobId);
    const outputShaDisk = await shaFile(file).catch(() => "");
    if (!outputSha || outputSha !== outputShaDisk) {
      send(res, 400, { error: "Итоговый хэш не сошёлся.", verified: false, receivedSha: outputShaDisk });
      return;
    }
    const codec = await probeCodec(file);
    if (codec !== lease.codec) {
      await unlinkQuiet(file);
      await failJob(ctx, lease, "Результат не того кодека. Подмена не принимается.");
      send(res, 409, { error: "Кодек результата не совпал с запросом.", verified: false, codec });
      return;
    }
    try {
      await stat(job.payload.destination);
      send(res, 409, { error: "Назначение уже есть. Оно не перезаписывается.", verified: false });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(job.payload.destination), { recursive: true });
    await rename(file, job.payload.destination);
    const store = createJobStore(ctx.directory);
    await store.markVerified(jobId, lease.token);
    await store.complete(jobId, lease.token);
    const worker = ctx.workers.get(lease.workerId);
    if (worker) worker.busy = Math.max(0, worker.busy - 1);
    ctx.leases.delete(jobId);
    send(res, 200, { verified: true, codec, outputSha256: outputShaDisk, sourceDeleted: false });
    return;
  }
  if (req.method === "POST" && parts[3] === "fail") {
    await failJob(ctx, lease, "Воркер остановил задание.");
    send(res, 200, { verified: false });
    return;
  }
  send(res, 404, { error: "Нет такого задания." });
}

function fits(worker: WorkerInfo, job: Job): boolean {
  const codec = codecOf(job.payload.handbrakeProfile);
  if (!codec) return false;
  const assigned = assignEncodeJobs(
    [{ id: job.id, codec, allowSoftware: job.payload.handbrakeProfile.endsWith(":sw") }],
    [{
      id: worker.id,
      os: "linux",
      slots: Math.max(0, worker.slots - worker.busy),
      probe: { hardwareAv1: false, videoToolbox: null, amf: null, encoders: worker.encoders },
    }],
  );
  return assigned[0]?.state === "leased";
}

function codecOf(profile: string): EncodeCodec | null {
  const match = /^c:(av1|hevc|h264):(sw|hw)$/.exec(profile);
  return match ? match[1] as EncodeCodec : null;
}

async function expireLeases(ctx: { directory: string; workers: Map<string, WorkerInfo>; leases: Map<string, Lease> }): Promise<void> {
  const store = createJobStore(ctx.directory);
  for (const [id, lease] of ctx.leases) {
    if (Date.now() <= lease.expiresAt) continue;
    await store.fail(id, lease.token, "Lease истёк.").catch(() => undefined);
    const worker = ctx.workers.get(lease.workerId);
    if (worker) worker.busy = Math.max(0, worker.busy - 1);
    ctx.leases.delete(id);
    await unlinkQuiet(incoming(ctx.directory, id));
  }
}

async function failJob(ctx: { directory: string; workers: Map<string, WorkerInfo>; leases: Map<string, Lease> }, lease: Lease, message: string): Promise<void> {
  const store = createJobStore(ctx.directory);
  await store.fail(lease.jobId, lease.token, message).catch(() => undefined);
  const worker = ctx.workers.get(lease.workerId);
  if (worker) worker.busy = Math.max(0, worker.busy - 1);
  ctx.leases.delete(lease.jobId);
  await unlinkQuiet(incoming(ctx.directory, lease.jobId));
}

function fresh(workers: Map<string, WorkerInfo>, id: string): WorkerInfo | null {
  const worker = workers.get(id);
  if (!worker || Date.now() - worker.lastSeen > 5_000) return null;
  return worker;
}

function readWorker(body: Record<string, unknown>): Omit<WorkerInfo, "lastSeen" | "busy"> | null {
  const id = typeof body.id === "string" ? body.id : "";
  const role = body.role === "pc" || body.role === "mac" ? body.role : null;
  const encoders = Array.isArray(body.encoders) ? body.encoders.filter((item): item is string => typeof item === "string") : [];
  const slots = Number(body.slots);
  const freeBytes = Number(body.freeBytes);
  if (!/^[a-z0-9-]{1,40}$/i.test(id) || !role || !Number.isInteger(slots) || slots < 1) return null;
  return { id, role, encoders, slots, freeBytes: Number.isFinite(freeBytes) ? freeBytes : 0 };
}

async function jobOf(directory: string, id: string): Promise<Job | null> {
  const page = await createJobStore(directory).list({ limit: 100 });
  return page.jobs.find((job) => job.id === id) ?? null;
}

function incoming(directory: string, id: string): string {
  return path.join(directory, "remote-incoming", id);
}

async function shaFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function readSlice(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function probeCodec(file: string): Promise<string | null> {
  const bin = process.env.FFPROBE || "ffprobe";
  const text = await new Promise<string>((resolve) => {
    const child = spawn(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("close", () => resolve(out.trim().toLowerCase()));
    child.on("error", () => resolve(""));
  });
  if (text.includes("av1")) return "av1";
  if (text.includes("hevc") || text.includes("265")) return "hevc";
  if (text.includes("264")) return "h264";
  return null;
}

function bearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return binaryBody(req).then((buf) => {
    const parsed = JSON.parse(buf.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  });
}

function binaryBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > CHUNK + 1024) {
        reject(new Error("Слишком большой кусок."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function unlinkQuiet(file: string): Promise<void> {
  await rm(file, { force: true });
}

export async function hubPort(directory: string): Promise<number> {
  const parsed = JSON.parse(await readFile(path.join(directory, "hub.json"), "utf8")) as { port: number };
  return parsed.port;
}
