import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getJob, readJobs } from "@/lib/jobs/store";
import {
  BD_R_SL_TOTAL_SECTORS,
  CD_DEFAULT_SECTORS,
  DISC_IMAGE_STUDIO_RELEASES,
  DVD_SL_TOTAL_SECTORS,
  buildDiscImageStudioPlan,
  missingBinaryMessage,
} from "@/lib/optical/disc-image-studio";
import { enqueueArtworkJob, waitForJob, type SpawnFn } from "@/lib/optical/jobs";

const artwork = "picture.png";
let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.SKLAD_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "sklad-optical-"));
  process.env.SKLAD_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("DiscImageStudio argv", () => {
  it("matches the documented cd-generate example", () => {
    // README.en.md: ./disc-image-studio cd-generate --input picture.png --output sample.wav --sectors 2
    const plan = buildDiscImageStudioPlan({
      platform: "darwin",
      action: "export",
      medium: "cd",
      artworkPath: "picture.png",
      outputPath: "sample.wav",
      sectors: 2,
    });
    expect(plan.executable).toBe("disc-image-studio");
    expect(plan.args).toEqual(["cd-generate", "--input", "picture.png", "--output", "sample.wav", "--sectors", "2"]);
    expect(plan.writesDisc).toBe(false);
    expect(plan.imapiProbe).toBe(false);
  });

  it("matches the documented DVD solve flags", () => {
    // DvdImageSolver help: "--image FILE" "--iso-output FILE" "--total-sectors N" "--fill-sectors N"
    // tests/test_cli_package.py: solve --image "input image.png" --iso-output dvd.iso --total-sectors 160 --fill-sectors 160
    const plan = buildDiscImageStudioPlan({
      platform: "linux",
      action: "export",
      medium: "dvd",
      artworkPath: "input image.png",
      outputPath: "dvd.iso",
      totalSectors: 160,
    });
    expect(plan.args).toEqual([
      "solve",
      "--image",
      "input image.png",
      "--iso-output",
      "dvd.iso",
      "--total-sectors",
      "160",
      "--fill-sectors",
      "160",
    ]);
  });

  it("uses the single-layer DVD and BD-R presets when the caller does not override capacity", () => {
    const dvd = buildDiscImageStudioPlan({
      platform: "darwin",
      action: "export",
      medium: "dvd",
      artworkPath: artwork,
      outputPath: "dvd.iso",
    });
    expect(dvd.args).toContain(String(DVD_SL_TOTAL_SECTORS));
    const bd = buildDiscImageStudioPlan({
      platform: "darwin",
      action: "export",
      medium: "bd-r",
      artworkPath: artwork,
      outputPath: "bd.iso",
    });
    // docs/ADDING_BLURAY.md: preset bd-r-sl-25gb; total sectors 12219392; dual-layer is not supported.
    expect(bd.args).toEqual([
      "bd-generate",
      "--input",
      artwork,
      "--output",
      "bd.iso",
      "--preset",
      "bd-r-sl-25gb",
      "--total-sectors",
      String(BD_R_SL_TOTAL_SECTORS),
    ]);
  });

  it("passes --data-dir for a BD-R image with attached files", () => {
    // docs/ADDING_BLURAY.md: bd-generate --input image.png --output bd-image.iso --data-dir C:\Files --volume-label BD_IMAGE
    const plan = buildDiscImageStudioPlan({
      platform: "win32",
      action: "export",
      medium: "bd-r",
      artworkPath: "image.png",
      outputPath: "bd-image.iso",
      dataDir: "C:\\Files",
      volumeLabel: "BD_IMAGE",
    });
    expect(plan.args).toEqual([
      "bd-generate",
      "--input",
      "image.png",
      "--output",
      "bd-image.iso",
      "--preset",
      "bd-r-sl-25gb",
      "--total-sectors",
      String(BD_R_SL_TOTAL_SECTORS),
      "--data-dir",
      "C:\\Files",
      "--volume-label",
      "BD_IMAGE",
      "--file-position",
      "inner",
    ]);
  });

  it("keeps IMAPI and live-burn flags off the macOS plan", () => {
    // README.en.md: "The CLI writes image files and audio tracks that you can burn with a compatible tool."
    // Live burning is Windows IMAPI2. macOS CLI has no burn flag.
    const plan = buildDiscImageStudioPlan({
      platform: "darwin",
      action: "export",
      medium: "cd",
      artworkPath: artwork,
      outputPath: "sample.wav",
    });
    expect(plan.args.join(" ")).not.toMatch(/burn-devices|burn-build-info|imapi|--burn/i);
    expect(plan.imapiProbe).toBe(false);
    expect(plan.args).toContain(String(CD_DEFAULT_SECTORS));
  });

  it("adds the Windows burn command only when the user chose записать", () => {
    // UnifiedCommandRunner help lists developer command `burn-devices` (IMAPI2 enumeration, not a write).
    const exported = buildDiscImageStudioPlan({
      platform: "win32",
      action: "export",
      medium: "cd",
      artworkPath: artwork,
      outputPath: "sample.wav",
      sectors: 2,
    });
    expect(exported.args.join(" ")).not.toMatch(/burn-devices|burn-build-info|imapi|--burn/i);
    const burn = buildDiscImageStudioPlan({
      platform: "win32",
      action: "burn",
      medium: "cd",
      artworkPath: artwork,
    });
    expect(burn.args).toEqual(["burn-devices"]);
    expect(burn.imapiProbe).toBe(true);
    expect(burn.writesDisc).toBe(false);
  });
});

describe("DiscImageStudio jobs", () => {
  it("rejects an unsupported medium before enqueue", async () => {
    // README.en.md: "Dual-layer discs are not currently supported."
    await expect(enqueueArtworkJob(base({ medium: "bd-r-dl", action: "export" }))).rejects.toThrow(/двухслойный BD/i);
    await expect(enqueueArtworkJob(base({ medium: "dvd-dl", action: "export" }))).rejects.toThrow(/DVD-DL/);
    await expect(enqueueArtworkJob(base({ medium: "bd-r", action: "burn", platform: "darwin" }))).rejects.toThrow(
      /офлайн-образ/,
    );
    expect(await readJobs()).toEqual([]);
  });

  it("errors when the binary is missing and does not mark the job done", async () => {
    const queued = await enqueueArtworkJob(base({ action: "export", mock: false }), {
      resolveBinary: async () => null,
    });
    expect(queued.status).toBe("queued");
    const finished = await waitForJob(queued.id);
    expect(finished.status).toBe("error");
    expect(finished.hardware).toBe(false);
    expect(finished.error).toContain("DiscImageStudio не найден");
    expect(finished.error).toContain(DISC_IMAGE_STUDIO_RELEASES);
    expect(finished.error).toBe(missingBinaryMessage());
  });

  it("returns from enqueue before the mock process finishes", async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = await enqueueArtworkJob(base({ action: "export", mock: true }), { hold });
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mid = await waitUntil((job) => job.status === "running", queued.id);
    expect(mid.status).not.toBe("done");
    release?.();
    const finished = await waitForJob(queued.id);
    expect(finished.status).toBe("done");
    expect(finished.mock).toBe(true);
    expect(finished.hardware).toBe(false);
    expect(finished.phase).toMatch(/mock: true/);
    expect(finished.phase).toMatch(/не записан/i);
  });

  it("marks the job done only after the fake process exits 0", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = async (_binary, args) => {
      seen.push(args);
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const queued = await enqueueArtworkJob(base({ action: "export", platform: "linux", sectors: 2, outputPath: "sample.wav" }), {
      resolveBinary: async () => "/opt/disc-image-studio",
      spawn,
    });
    expect(queued.status).toBe("queued");
    const finished = await waitForJob(queued.id);
    expect(seen).toEqual([["cd-generate", "--input", artwork, "--output", "sample.wav", "--sectors", "2"]]);
    expect(finished.status).toBe("done");
    expect(finished.hardware).toBe(false);
    expect(finished.phase).toMatch(/не записан/i);
  });

  it("does not create a second active job for the same artwork", async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await enqueueArtworkJob(base({ action: "export", mock: true }), { hold });
    const second = await enqueueArtworkJob(base({ action: "export", mock: true }), { hold });
    expect(second.id).toBe(first.id);
    const active = (await readJobs()).filter((job) => job.status === "queued" || job.status === "running");
    expect(active).toHaveLength(1);
    release?.();
    await waitForJob(first.id);
  });
});

function base(overrides: Partial<Parameters<typeof enqueueArtworkJob>[0]> = {}) {
  return {
    platform: "darwin" as const,
    action: "export" as const,
    medium: "cd",
    artworkPath: artwork,
    outputPath: "sample.wav",
    ...overrides,
  };
}

async function waitUntil(predicate: (job: NonNullable<Awaited<ReturnType<typeof waitForJob>>>) => boolean, id: string) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const job = await getJob(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timed out waiting for job");
}
