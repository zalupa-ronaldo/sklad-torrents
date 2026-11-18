import { describe, expect, it } from "vitest";

import { combineLane, parseLibraryCsv, parseQueueLog, parseStatusJson, readAv1Status } from "../../../agents/pc-agent/av1-status.mjs";
import { av1StatusUrl, pullAv1Status } from "@/lib/transcode/av1-status";

describe("AV1 status", () => {
  it("reads only the fields the logs actually contain", () => {
    const status = parseStatusJson(
      JSON.stringify({ currentFile: "Suits.mkv", percent: 40, fps: 18.5, etaSec: 90, done: 2, total: 8, spaceFreedBytes: 1000, error: "диск заполнен" }),
    );
    const log = parseQueueLog("encoding 12%\nfps: 9\nETA: 30\nERROR mux failed");
    const csv = parseLibraryCsv("file,status,freed\nA.mkv,done,10\nB.mkv,running,5\n");
    const lane = combineLane([status, log, csv]);
    expect(lane.currentFile).toBe("Suits.mkv");
    expect(lane.percent).toBe(40);
    expect(lane.fps).toBe(18.5);
    expect(lane.etaSec).toBe(90);
    expect(lane.done).toBe(2);
    expect(lane.total).toBe(8);
    expect(lane.spaceFreedBytes).toBe(1000);
    expect(lane.errors).toEqual(expect.arrayContaining(["диск заполнен", "ERROR mux failed"]));
    expect(parseStatusJson("not-json").errors[0]).toContain("не JSON");
    const fromCsv = combineLane([parseStatusJson(""), parseQueueLog(""), csv]);
    expect(fromCsv.currentFile).toBe("B.mkv");
    expect(fromCsv.done).toBe(1);
    expect(fromCsv.total).toBe(2);
    expect(fromCsv.spaceFreedBytes).toBe(15);
  });

  it("does not start a job and reports a missing log without inventing progress", async () => {
    const files = new Map<string, string>([
      ["S:\\сирики\\Suits_AV1\\_logs\\status.json", JSON.stringify({ file: "ep01.mkv", progress: 0.25 })],
    ]);
    const readFile = async (file: string) => {
      const text = files.get(file);
      if (text === undefined) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return text;
    };
    const status = await readAv1Status({ readFile });
    expect(status.started).toBe(false);
    expect(status.online).toBe(true);
    const suits = status.lanes.find((lane) => lane.id === "suits");
    expect(suits?.currentFile).toBe("ep01.mkv");
    expect(suits?.percent).toBe(25);
    expect(suits?.fps).toBeNull();
    expect(suits?.errors.some((error) => error.includes("queue.log"))).toBe(true);
    const library = status.lanes.find((lane) => lane.id === "library");
    expect(library?.currentFile).toBeNull();
    expect(library?.percent).toBeNull();
  });

  it("shows the PC agent offline when the status URL does not answer", async () => {
    expect(av1StatusUrl({ SKLAD_PC_AGENT_URL: "http://192.168.0.16:4730" } as unknown as NodeJS.ProcessEnv)).toBe(
      "http://192.168.0.16:4730/v1/av1-status",
    );
    const offline = await pullAv1Status({
      url: "http://192.168.0.16:4730/v1/av1-status",
      fetchImpl: async () => {
        throw new Error("offline");
      },
      timeoutMs: 20,
    });
    expect(offline.online).toBe(false);
    expect(offline.started).toBe(false);
    expect(offline.lanes).toEqual([]);
    const online = await pullAv1Status({
      url: "http://agent.local/v1/av1-status",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ lanes: [{ id: "suits", label: "Suits AV1", currentFile: "a.mkv", percent: 10, fps: 1, etaSec: 2, done: 1, total: 3, spaceFreedBytes: 4, errors: [] }] }),
      }),
    });
    expect(online.online).toBe(true);
    expect(online.lanes[0]?.currentFile).toBe("a.mkv");
    expect(online.started).toBe(false);
  });
});
