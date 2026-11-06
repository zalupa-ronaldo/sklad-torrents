import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { executeIndexPlan } from "../../src/addons/drives/execute-index.ts";
import { selectIndexStrategy } from "../../src/addons/drives/strategy.ts";
import type { CollectedVolume, HostOs, IndexPayload } from "../../src/addons/drives/types.ts";
import { readNtfsLetter, readUsn } from "./indexers.mts";
import { walkTree } from "./walk.mts";

export interface AgentCollectResult {
  elevated: boolean;
  volumes: CollectedVolume[];
  note: string;
}

interface TrackedVolume extends CollectedVolume {
  index: IndexPayload | null;
  indexedAt: number;
  usnStart: string | null;
  freeAtIndex: number;
}

interface AgentEvent {
  id: number;
  at: string;
  type: "attach" | "detach" | "index";
  serial: string;
  volumeUuid: string;
  filesystem?: string;
  mountPaths?: string[];
  progress?: number;
  state?: string;
  strategy?: string;
}

function volumeKey(volume: { serial: string; volumeUuid: string }): string {
  return `${volume.serial}|${volume.volumeUuid}`;
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function startAgent(options: {
  port: number;
  hostId: string;
  hostName: string;
  os: HostOs;
  collect: () => Promise<AgentCollectResult>;
  mockIndex?: IndexPayload | null;
  intervalMs?: number;
}) {
  let elevated = false;
  let note = "";
  let volumes: TrackedVolume[] = [];
  const events: AgentEvent[] = [];
  let eventId = 0;
  const running = new Set<string>();
  let ticking = false;
  let restoreFailed = false;
  const disabled = new Set<string>();
  const snapshotPath = process.env.SKLAD_AGENT_SNAPSHOT || path.join(process.cwd(), "data", "drive-agent-snapshot.json.gz");
  let persistChain: Promise<unknown> = Promise.resolve();
  function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const data = await promisify(gzip)(JSON.stringify({ volumes }));
      await writeFile(`${snapshotPath}.tmp`, data);
      await rename(`${snapshotPath}.tmp`, snapshotPath);
    }).catch((error) => { note = `Не удалось сохранить индекс: ${String(error)}`; });
  }
  const ready = (async () => {
    try {
      const data = JSON.parse(await readFile(path.join(process.cwd(), "data", "drive-agent-disabled.json"), "utf8"));
      for (const letter of data.letters ?? []) disabled.add(String(letter).toUpperCase());
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") note = "Не удалось прочитать исключения дисков."; }
    try {
      const saved = JSON.parse((await promisify(gunzip)(await readFile(snapshotPath))).toString());
      volumes = (saved.volumes ?? []).map((v: TrackedVolume) => ({ ...v, indexedAt: v.indexedAt || Date.now(), freeAtIndex: v.freeBytes, usnStart: v.usnStart ?? null }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { restoreFailed = true; note = "Снимок повреждён: автоматическое сканирование отключено, нужен ручной запуск."; } }
  })();

  function pushEvent(event: Omit<AgentEvent, "id" | "at">) {
    eventId += 1;
    events.push({ ...event, id: eventId, at: new Date().toISOString() });
    if (events.length > 400) events.shift();
  }

  async function indexVolume(volume: TrackedVolume) {
    const key = volumeKey(volume);
    if (running.has(key) || disabled.has((volume.letter ?? "").toUpperCase())) return;
    running.add(key);
    const previousIndex = volume.index;
    volume.index = {
      ...previousIndex,
      state: volume.busy ? "paused" : "running",
      progress: volume.index?.progress ?? 0,
      strategy: selectIndexStrategy({
        filesystem: volume.filesystem,
        platform: options.os,
        elevated,
      }).strategy,
    };
    try {
      const result = await executeIndexPlan(
        {
          filesystem: volume.filesystem,
          platform: options.os,
          elevated,
          busy: volume.busy,
          // fsutil text has leaf names, not reliable full paths. Do not publish it
          // as a complete delta; explicit manual refresh uses a complete tree.
          usnCheckpoint: false,
        },
        {
          readMft: () => readNtfsLetter(volume.letter ?? ""),
          readUsn: async () => {
            const journal = await readUsn(volume.letter ?? "", volume.usnStart);
            if (journal.nextUsn) volume.usnStart = journal.nextUsn;
            return { delta: journal.delta };
          },
          walk: () => walkTree(volume.mountPaths[0] ?? ""),
        },
      );
      if (result.payload.state === "complete" && result.payload.files) {
        result.payload.revision = randomUUID();
        result.payload.recordCount = result.payload.files.length;
      }
      // A pause/error is metadata, never a destructive replacement of the last tree.
      volume.index = { ...previousIndex, ...result.payload };
      if (result.payload.state === "complete") persist();
      volume.indexedAt = Date.now();
      volume.freeAtIndex = volume.freeBytes;
      pushEvent({
        type: "index",
        serial: volume.serial,
        volumeUuid: volume.volumeUuid,
        filesystem: volume.filesystem,
        progress: result.payload.progress,
        state: result.payload.state,
        strategy: result.payload.strategy,
      });
    } catch (error) {
      volume.index = { ...previousIndex, state: "error", progress: previousIndex?.progress ?? 0, message: String(error) };
    } finally {
      running.delete(key);
    }
  }

  async function tick() {
    await ready;
    if (ticking) return;
    ticking = true;
    try { await collectAndIndex(); } finally { ticking = false; }
  }

  async function collectAndIndex() {
    let collected: AgentCollectResult;
    try {
      collected = await options.collect();
    } catch (error) {
      note = error instanceof Error ? error.message : "Сбор томов не выполнился.";
      return;
    }
    elevated = collected.elevated;
    note = collected.note;
    const previous = new Map(volumes.map((volume) => [volumeKey(volume), volume]));
    const next: TrackedVolume[] = [];
    for (const volume of collected.volumes) {
      const key = volumeKey(volume);
      const prior = previous.get(key);
      if (!prior) {
        pushEvent({
          type: "attach",
          serial: volume.serial,
          volumeUuid: volume.volumeUuid,
          filesystem: volume.filesystem,
          mountPaths: volume.mountPaths,
        });
      }
      // Keep object identity while an asynchronous index job owns this volume.
      const tracked = prior ?? { ...volume, index: options.mockIndex ?? null, indexedAt: 0, usnStart: null, freeAtIndex: -1 };
      Object.assign(tracked, volume);
      next.push(tracked);
      previous.delete(key);
    }
    for (const gone of previous.values()) {
      pushEvent({ type: "detach", serial: gone.serial, volumeUuid: gone.volumeUuid, filesystem: gone.filesystem });
    }
    volumes = next;
    if (options.mockIndex) return;
    for (const volume of volumes) {
      // Complete snapshots do not expire. Free-space changes are not proof of a
      // pathname change; never turn a UI refresh into another full MFT read.
      const needs = !restoreFailed && !disabled.has((volume.letter ?? "").toUpperCase()) && !volume.busy &&
        (!volume.index || (volume.index.state === "paused" && !volume.index.files));
      if (needs) void indexVolume(volume);
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      send(response, 200, { ok: true, hostId: options.hostId, os: options.os, elevated, note });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rescan") {
      const volume = volumes.find((v) => v.serial === url.searchParams.get("serial") && v.volumeUuid === url.searchParams.get("uuid"));
      if (!volume || disabled.has((volume.letter ?? "").toUpperCase())) { send(response, 404, { error: "Том исключён или недоступен." }); return; }
      if (running.has(volumeKey(volume)) || volume.busy) { send(response, 409, { error: "Том занят." }); return; }
      void indexVolume(volume);
      send(response, 202, { accepted: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/files") {
      const volume = volumes.find((v) => v.serial === url.searchParams.get("serial") && v.volumeUuid === url.searchParams.get("uuid"));
      if (!volume || disabled.has((volume.letter ?? "").toUpperCase())) { send(response, 404, { error: "Том недоступен." }); return; }
      const index = volume.index;
      if (!index?.files || index.revision !== url.searchParams.get("revision")) { send(response, 409, { error: "Снимок изменился." }); return; }
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const limit = Math.min(10000, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 10000)));
      send(response, 200, { revision: index.revision, total: index.files.length, files: index.files.slice(offset, offset + limit) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/volumes") {
      send(response, 200, {
        hostId: options.hostId,
        hostName: options.hostName,
        os: options.os,
        elevated,
        note,
        volumes: volumes.filter((volume) => !disabled.has((volume.letter ?? "").toUpperCase())).map((volume) => ({
          serial: volume.serial,
          volumeUuid: volume.volumeUuid,
          filesystem: volume.filesystem,
          volumeName: volume.volumeName,
          mountPaths: volume.mountPaths,
          totalBytes: volume.totalBytes,
          freeBytes: volume.freeBytes,
          busy: volume.busy,
          letter: volume.letter,
          index: !volume.index ? null : {
            state: volume.index.state, progress: volume.index.progress,
            message: volume.index.message, strategy: volume.index.strategy,
            revision: volume.index.revision,
            recordCount: volume.index.files?.length ?? volume.index.recordCount ?? 0,
            ...(url.searchParams.get("files") === "1" ? { files: volume.index.files, delta: volume.index.delta } : {}),
          },
        })),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const since = Number(url.searchParams.get("since") || "0");
      send(response, 200, { events: events.filter((event) => event.id > since) });
      return;
    }
    send(response, 404, { error: "Неизвестный путь агента." });
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(`${options.hostName} слушает 0.0.0.0:${options.port}`);
  });
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? 4000);
  timer.unref?.();
  server.once("close", () => clearInterval(timer));
  return server;
}
