import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import { dataDir } from "@/lib/qbittorrent/store";
import { encodeArgv, type MediaFacts } from "@/lib/transcode/encode-plan";
import { probeEncoder } from "@/lib/transcode/encode-worker";

const CHUNK = 64 * 1024;

export async function runEncodeWorker(input: { hub: string; token: string; id: string; role: "pc" | "mac"; directory?: string }): Promise<void> {
  const directory = input.directory ?? dataDir();
  const hub = input.hub.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${input.token}`, "content-type": "application/json" };
  const encoders = (process.env.SKLAD_ENCODER_LIST || "").split(",").map((item) => item.trim()).filter(Boolean);
  const probe = encoders.length > 0 ? null : await probeEncoder();
  const advertised = encoders.length > 0 ? encoders : probe?.encoders ?? [];
  const binary = probe?.binary;
  if (!binary && encoders.length === 0) throw new Error("HandBrakeCLI не найден у воркера.");
  await post(hub, "/v1/workers", headers, { id: input.id, role: input.role, encoders: advertised, slots: 1, freeBytes: await freeBytes(directory) });
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  while (!stop) {
    await post(hub, "/v1/workers/heartbeat", headers, { id: input.id, freeBytes: await freeBytes(directory) }).catch(() => undefined);
    const claimed = await post(hub, "/v1/jobs/claim", headers, { id: input.id });
    const job = claimed.job as { jobId: string; lease: string; revision: number; codec: "av1" | "hevc" | "h264"; bytes: number; sourceSha256: string } | null;
    if (!job) {
      await delay(200);
      continue;
    }
    const startedAt = Date.now();
    const staging = path.join(directory, "staging", job.jobId);
    await mkdir(staging, { recursive: true });
    const source = path.join(staging, "in.mp4");
    const output = path.join(staging, "out.mp4");
    try {
      await download(hub, headers, job, source);
      const hold = Number(process.env.SKLAD_ENCODE_HOLD_MS || 0);
      if (hold > 0) await delay(hold);
      if (!binary) throw new Error("Нет HandBrakeCLI для настоящего кодирования.");
      const facts: MediaFacts = { format: "mp4", duration: 1, videoCodec: "h264", audio: 1, subtitles: 0, chapters: 0, hdr: false };
      const args = encodeArgv({ binary, source, output, codec: job.codec, sourceFacts: facts, encoders: advertised });
      const beat = setInterval(() => {
        void post(hub, `/v1/jobs/${job.jobId}/heartbeat`, { ...headers, "x-lease": job.lease }, {}).catch(() => undefined);
      }, 400);
      const code = await run(args);
      clearInterval(beat);
      if (code !== 0) throw new Error(`HandBrake завершился с кодом ${code ?? "нет"}.`);
      const outputSha256 = await shaFile(output);
      await upload(hub, headers, job, output);
      const finished = await post(hub, `/v1/jobs/${job.jobId}/finish`, { ...headers, "x-lease": job.lease }, { revision: job.revision, outputSha256 });
      await appendLog(directory, { pid: process.pid, id: input.id, role: input.role, jobId: job.jobId, startedAt, finishedAt: Date.now(), verified: finished.verified === true, codec: job.codec });
    } catch {
      await post(hub, `/v1/jobs/${job.jobId}/fail`, { ...headers, "x-lease": job.lease }, {}).catch(() => undefined);
      await appendLog(directory, { pid: process.pid, id: input.id, role: input.role, jobId: job.jobId, startedAt, finishedAt: Date.now(), verified: false, codec: job.codec });
    }
  }
}

async function download(hub: string, headers: Record<string, string>, job: { jobId: string; lease: string; bytes: number; sourceSha256: string }, file: string): Promise<void> {
  const handle = createWriteStream(file, { flags: "w" });
  let offset = 0;
  const hash = createHash("sha256");
  while (offset < job.bytes) {
    const response = await fetch(`${hub}/v1/jobs/${job.jobId}/input?offset=${offset}&length=${CHUNK}`, { headers: { ...headers, "x-lease": job.lease } });
    if (!response.ok) throw new Error("Вход не отдан.");
    const bytes = Buffer.from(await response.arrayBuffer());
    const announced = response.headers.get("x-chunk-sha256");
    if (announced !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Хэш куска входа не сошёлся.");
    hash.update(bytes);
    handle.write(bytes);
    offset += bytes.length;
  }
  await new Promise((resolve) => handle.end(resolve));
  if (hash.digest("hex") !== job.sourceSha256) throw new Error("Вход не совпал с манифестом задания.");
}

async function upload(hub: string, headers: Record<string, string>, job: { jobId: string; lease: string }, file: string): Promise<void> {
  const size = (await stat(file)).size;
  let offset = 0;
  const stream = createReadStream(file, { highWaterMark: CHUNK });
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    const response = await fetch(`${hub}/v1/jobs/${job.jobId}/output?offset=${offset}`, {
      method: "PUT",
      headers: { authorization: headers.authorization, "x-lease": job.lease, "x-chunk-sha256": createHash("sha256").update(bytes).digest("hex"), "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!response.ok) throw new Error("Выход не принят.");
    offset += bytes.length;
  }
  if (offset !== size) throw new Error("Выход отправлен не целиком.");
}

async function run(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(args[0]!, args.slice(1), { shell: false, stdio: "ignore" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

async function post(hub: string, pathname: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${hub}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok && response.status !== 409) throw new Error(typeof parsed.error === "string" ? parsed.error : "Запрос не прошёл.");
  return parsed;
}

async function shaFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function freeBytes(directory: string): Promise<number> {
  await mkdir(directory, { recursive: true });
  const space = await statfs(directory);
  return Number(space.bavail) * Number(space.bsize);
}

async function appendLog(directory: string, row: Record<string, unknown>): Promise<void> {
  const file = path.join(directory, "encode-log.json");
  let rows: unknown[] = [];
  try {
    rows = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")) as unknown[];
  } catch {
    rows = [];
  }
  rows.push(row);
  await writeFile(file, JSON.stringify(rows), "utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
