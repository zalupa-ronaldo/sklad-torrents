import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_OFFLINE } from "@/lib/optical/errors";
import { buildMacOpticalJob } from "@/lib/optical/mac-controller";
import { detectMacRecorders } from "@/lib/optical/mac-detector";
import { enqueueOpticalJob } from "@/lib/optical/service";
import { claimAndExecute } from "@/lib/optical/protocol";

const DRUTIL = `
 Vendor   Product           Rev
 MATSHITA DVD-R   UJ-8A8    HA13
           Type: DVD-RW               Name: /dev/disk2
`;

describe("Mac optical controller", () => {
  let dir = "";
  let previousData: string | undefined;
  let previousAgent: string | undefined;
  let previousUrl: string | undefined;

  beforeEach(async () => {
    previousData = process.env.SKLAD_DATA_DIR;
    previousAgent = process.env.SKLAD_OPTICAL_AGENT;
    previousUrl = process.env.SKLAD_PC_AGENT_URL;
    dir = await mkdtemp(path.join(tmpdir(), "sklad-win-optical-"));
    process.env.SKLAD_DATA_DIR = dir;
    delete process.env.SKLAD_PC_AGENT_URL;
    delete process.env.SKLAD_OPTICAL_AGENT;
  });

  afterEach(async () => {
    if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
    else process.env.SKLAD_DATA_DIR = previousData;
    if (previousAgent === undefined) delete process.env.SKLAD_OPTICAL_AGENT;
    else process.env.SKLAD_OPTICAL_AGENT = previousAgent;
    if (previousUrl === undefined) delete process.env.SKLAD_PC_AGENT_URL;
    else process.env.SKLAD_PC_AGENT_URL = previousUrl;
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a Windows-agent job and does not plan a local macOS burn", () => {
    const job = buildMacOpticalJob({
      kind: "discimagestudio-live",
      sourcePath: "E:\\Pictures\\cover.png",
      driveId: "win-dvd-0",
    });
    expect(job.host).toBe("pc-agent");
    const text = [...job.argv, ...job.plan].join("\n");
    expect(text).not.toMatch(/\bdrutil\s+burn\b/);
    expect(text).not.toMatch(/\bhdiutil\s+burn\b/);
    expect(text).toMatch(/IMAPI2/);
    expect(job.verified).toBe(false);
    expect(job.physicalDiscBurned).toBe(false);
    expect(job.claimedBy).toBeNull();
  });

  it("keeps offline image generation experimental and free of a drive", () => {
    const job = buildMacOpticalJob({
      kind: "discimagestudio-offline",
      sourcePath: "picture.png",
      outputPath: "sample.iso",
      profile: "dvd",
      offlineHost: "darwin",
    });
    expect(job.driveId).toBeNull();
    expect(job.argv.join(" ")).toContain("disc-image-studio");
    expect(job.plan.join(" ")).toMatch(/experimental/);
    expect([...job.argv, ...job.plan].join("\n")).not.toMatch(/\b(?:drutil|hdiutil)\s+burn\b/);
  });

  it("does not report a local recorder from a drutil listing", () => {
    const report = detectMacRecorders(DRUTIL);
    expect(report.recorders).toEqual([]);
    expect(report.lookedForLocalDrive).toBe(false);
    expect(report.message).toMatch(/Windows/);
  });

  it("leaves the job queued when the Windows agent is offline", async () => {
    process.env.SKLAD_OPTICAL_AGENT = "offline";
    const job = await enqueueOpticalJob({
      kind: "burn",
      sourcePath: "E:\\Archive\\disc.iso",
      driveId: "win-dvd-0",
    });
    expect(job.host).toBe("pc-agent");
    expect(job.status).toBe("queued");
    expect(job.error).toBe(AGENT_OFFLINE);
    expect(job.verified).toBe(false);
    const stored = JSON.parse(await readFile(path.join(dir, "optical-jobs.json"), "utf8")) as {
      jobs: { argv: string[] }[];
    };
    expect(stored.jobs[0]?.argv.join(" ")).not.toMatch(/\b(?:drutil|hdiutil)\s+burn\b/);
  });

  it("verifies only after the Windows worker sees a successful burn exit", () => {
    const burn = buildMacOpticalJob({
      kind: "burn",
      sourcePath: "E:\\Archive\\disc.iso",
      driveId: "win-dvd-0",
    });
    const burned = claimAndExecute(burn, { workerHost: "pc-agent", mock: true });
    expect(burned.claimedBy).toBe("pc-agent");
    expect(burned.burnExited).toBe(true);
    expect(burned.exitCode).toBe(0);
    expect(burned.verified).toBe(false);
    expect(burned.driveName).toBe("HL-DT-ST DVDRAM GP57ES60");
    expect(burned.physicalDiscBurned).toBe(false);

    const verify = buildMacOpticalJob({ kind: "verify", driveId: "win-dvd-0" });
    const checked = claimAndExecute(verify, { workerHost: "pc-agent", mock: true, priorJobs: [burned] });
    expect(checked.verified).toBe(true);
    expect(checked.verifiedBy).toBe("pc-agent");

    const early = claimAndExecute(
      buildMacOpticalJob({ kind: "verify", driveId: "win-dvd-0" }),
      { workerHost: "pc-agent", mock: true, priorJobs: [] },
    );
    expect(early.verified).toBe(false);
    expect(early.status).toBe("failed");
    expect(() => claimAndExecute(burn, { workerHost: "darwin" })).toThrow(/агент Windows/);
  });

  it("does not erase rewritable media without a confirmation stored on the job", () => {
    const job = buildMacOpticalJob({
      kind: "burn",
      sourcePath: "E:\\Archive\\disc.iso",
      driveId: "win-dvd-rw",
      eraseConfirmed: false,
    });
    expect(job.argv.join(" ")).not.toContain("--erase-rewritable");
    const blocked = claimAndExecute(job, { workerHost: "pc-agent", mock: true });
    expect(blocked.status).toBe("queued");
    expect(blocked.log.join("\n")).toMatch(/стирание не выполнялось/);
    expect(blocked.physicalDiscBurned).toBe(false);
  });
});
