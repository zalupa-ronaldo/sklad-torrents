import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { demoDisks } from "@/lib/kernel/demo-seed";
import { SkladError } from "@/lib/kernel/errors";
import { buildDryRun, enableAutomation, loadPolicy, projectTorrents, runDryRun, savePolicy } from "@/lib/kernel/policies";
import { resetMockStateForTests } from "@/lib/qbittorrent/mock-client";

describe("content policies", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-policy-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetMockStateForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("previews destinations and never deletes", async () => {
    const run = buildDryRun(await projectTorrents(), demoDisks(), await loadPolicy());
    expect(run.deletesAnything).toBe(false);
    expect(run.items.length).toBeGreaterThan(3);
    expect(run.items.every((item) => item.deletes === false)).toBe(true);
    expect(run.items.find((item) => item.name.includes("Интерстеллар"))?.kind).toBe("movie");
    expect(run.items.find((item) => item.name.includes("God of War"))?.kind).toBe("game-psp");
    expect(run.items.find((item) => item.name.includes("Ubuntu"))?.kind).toBe("software");
    expect(run.items.find((item) => item.name.includes("Control"))?.detail).toMatch(/не удаляются/);
    expect(run.items.find((item) => item.name.includes("Интерстеллар"))?.detail).toMatch(/setLocation/);
  });

  it("blocks automation until a fresh dry-run and blocks it again after an edit", async () => {
    await expect(enableAutomation(true)).rejects.toThrow(SkladError);
    const run = await runDryRun(demoDisks());
    expect(run.deletesAnything).toBe(false);
    expect((await enableAutomation(true)).automationEnabled).toBe(true);
    await savePolicy(await loadPolicy());
    await expect(enableAutomation(true)).rejects.toThrow(/Ничего не удалено/);
    expect((await loadPolicy()).automationEnabled).toBe(false);
  });
});
