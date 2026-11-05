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
}) {
  let elevated = false;
  let note = "";
  let volumes: TrackedVolume[] = [];
  const events: AgentEvent[] = [];
  let eventId = 0;
  const running = new Set<string>();

  function pushEvent(event: Omit<AgentEvent, "id" | "at">) {
    eventId += 1;
    events.push({ ...event, id: eventId, at: new Date().toISOString() });
    if (events.length > 400) events.shift();
  }

  async function indexVolume(volume: TrackedVolume) {
    const key = volumeKey(volume);
    if (running.has(key)) return;
    running.add(key);
    volume.index = {
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
          usnCheckpoint: Boolean(volume.usnStart),
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
      volume.index = result.payload;
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
    } finally {
      running.delete(key);
    }
  }

  async function tick() {
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
      next.push({
        ...volume,
        index: prior?.index ?? options.mockIndex ?? null,
        indexedAt: prior?.indexedAt ?? 0,
        usnStart: prior?.usnStart ?? null,
        freeAtIndex: prior?.freeAtIndex ?? -1,
      });
      previous.delete(key);
    }
    for (const gone of previous.values()) {
      pushEvent({ type: "detach", serial: gone.serial, volumeUuid: gone.volumeUuid, filesystem: gone.filesystem });
    }
    volumes = next;
    if (options.mockIndex) return;
    for (const volume of volumes) {
      const aged = Date.now() - volume.indexedAt > 15 * 60_000;
      const spaceChanged =
        volume.totalBytes > 0 && Math.abs(volume.freeBytes - volume.freeAtIndex) > volume.totalBytes * 0.01;
      const needs =
        !volume.index ||
        volume.index.state === "error" ||
        (volume.index.state === "complete" && (aged || spaceChanged)) ||
        (volume.busy && volume.index.state !== "paused");
      if (needs) void indexVolume(volume);
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      send(response, 200, { ok: true, hostId: options.hostId, os: options.os, elevated, note });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/volumes") {
      send(response, 200, {
        hostId: options.hostId,
        hostName: options.hostName,
        os: options.os,
        elevated,
        note,
        volumes: volumes.map((volume) => ({
          serial: volume.serial,
          volumeUuid: volume.volumeUuid,
          filesystem: volume.filesystem,
          volumeName: volume.volumeName,
          mountPaths: volume.mountPaths,
          totalBytes: volume.totalBytes,
          freeBytes: volume.freeBytes,
          busy: volume.busy,
          letter: volume.letter,
          index: volume.index,
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
  const timer = setInterval(() => void tick(), 4000);
  timer.unref?.();
  return server;
}
