import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmSourceDelete, planMove } from "@/addons/media-games/move";
import { startEncodeHub } from "@/lib/encode-remote/hub";
import { createJobStore } from "@/lib/jobs/engine";
import { localJobHost } from "@/lib/jobs/local-host";
import { assignEncodeJobs } from "@/lib/transcode/assign";
import {
  advertisedHardwareBlock,
  assertEncodePaths,
  capabilityFromHelp,
  encodeArgv,
  verifyMedia,
  VCE_AV1_SMOKE,
} from "@/lib/transcode/encode-plan";
import { sha256Hex, treeReader } from "@/lib/integrity/hash";
import {
  clearIntegrityRuntimeForTests,
  enqueueIntegrity,
  getIntegrityJob,
} from "@/lib/integrity/engine";
import { resetIntegrityForTests } from "@/lib/integrity/store";
import {
  HANDBRAKE_HELP,
  MAC_HANDBRAKE,
  MEDIA_FACTS,
  WINDOWS_HANDBRAKE,
} from "@/windows-emulation/world";

const dirs: string[] = [];
let previousData: string | undefined;

beforeEach(() => {
  previousData = process.env.SKLAD_DATA_DIR;
});

afterEach(async () => {
  clearIntegrityRuntimeForTests();
  if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousData;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HandBrake on Mac and Windows", () => {
  it("gives each machine its own next file and keeps AV1 on software after VCE 3221225477", () => {
    const hosts = [MAC_HANDBRAKE, WINDOWS_HANDBRAKE];
    const leased = assignEncodeJobs(
      [
        { id: "on-mac", codec: "h264", allowSoftware: false },
        { id: "on-pc", codec: "hevc", allowSoftware: false },
      ],
      hosts,
    );
    expect(leased.map((row) => [row.jobId, row.hostId, row.encoder, row.state])).toEqual([
      ["on-mac", "mac-local", "hardware", "leased"],
      ["on-pc", "pc-agent", "hardware", "leased"],
    ]);

    const fallback = assignEncodeJobs(
      [{ id: "av1", codec: "av1", allowSoftware: true }],
      [WINDOWS_HANDBRAKE],
    );
    expect(fallback[0]).toMatchObject({ hostId: "pc-agent", codec: "av1", encoder: "software", state: "leased" });

    const blocked = assignEncodeJobs(
      [{ id: "av1-hw", codec: "av1", allowSoftware: false }],
      hosts,
    );
    expect(blocked[0]?.state).toBe("blocked");
    expect(blocked[0]?.codec).toBe("av1");
    expect(blocked[0]?.reason).toMatch(/HEVC не делается/);

    const capability = capabilityFromHelp(HANDBRAKE_HELP, "HandBrake 1.11.1");
    expect(capability.hardwareAv1).toBe(false);
    expect(capability.advertisedHardwareAv1).toEqual(["vce_av1", "vce_av1_10bit"]);
    expect(advertisedHardwareBlock(capability.encoders)).toContain(String(VCE_AV1_SMOKE.code));

    const argv = encodeArgv({
      binary: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
      source: "D:\\фильмы\\Interstellar.mkv",
      output: "D:\\фильмы\\Interstellar.av1.mkv",
      codec: "av1",
      container: "mkv",
      sourceFacts: MEDIA_FACTS,
      encoders: capability.encoders,
    });
    expect(argv).toContain("svt_av1");
    expect(argv.join(" ")).not.toMatch(/vce_av1/);
    expect(() => assertEncodePaths(["Z:\\фильмы\\Interstellar.mkv"])).toThrow(/E и Z не открываются/);
  });

  it("keeps a file on the machine that already has it, and hashes a copy when it must move", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-hb-"));
    dirs.push(dir);
    const store = createJobStore(dir);
    const onPc = await store.enqueue({
      kind: "transcode",
      host: "pc-agent",
      source: "D:\\фильмы\\Interstellar.mkv",
      destination: "D:\\фильмы\\Interstellar.av1.mkv",
      handbrakeProfile: "c:av1:sw",
    });
    const onMac = await store.enqueue({
      kind: "transcode",
      host: "mac-local",
      source: "/Volumes/vault/Cinema/Dune.mkv",
      destination: "/Volumes/vault/Cinema/Dune.av1.mkv",
      handbrakeProfile: "c:h264:hw",
    });
    expect(await store.claimNext("mac-local")).toMatchObject({ id: onMac.job.id });
    expect((await store.claimNext("pc-agent"))?.id).toBe(onPc.job.id);
    expect(await store.claimNext("mac-local")).toBeNull();

    process.env.SKLAD_DATA_DIR = dir;
    clearIntegrityRuntimeForTests();
    await resetIntegrityForTests();
    const bytes = new TextEncoder().encode("frame");
    const queued = await enqueueIntegrity({
      kind: "copy",
      title: "Копия на другую машину",
      source: treeReader({ "Interstellar.mkv": bytes }),
      destination: treeReader({ "Interstellar.mkv": bytes }),
    });
    const hashed = await waitHash(queued.id);
    expect(hashed.files.every((file) => file.sha256 === sha256Hex(bytes) && file.status === "match")).toBe(true);
    expect(hashed.deleteAllowed).toBe(false);
  });

  it("does not replace the original until duration, tracks, playback and an explicit confirm all pass", () => {
    const bad = verifyMedia({
      codec: "av1",
      container: "mkv",
      source: MEDIA_FACTS,
      output: { ...MEDIA_FACTS, format: "matroska", duration: 40, videoCodec: "av1", audio: 0 },
      decodeOk: false,
      exitCode: VCE_AV1_SMOKE.code,
    });
    expect(bad.verified).toBe(false);
    expect(bad.durationOk).toBe(false);
    expect(bad.tracksOk).toBe(false);

    const good = verifyMedia({
      codec: "av1",
      container: "mkv",
      source: MEDIA_FACTS,
      output: { ...MEDIA_FACTS, format: "matroska,webm", duration: 120.1, videoCodec: "av1" },
      decodeOk: true,
      exitCode: 0,
    });
    expect(good).toMatchObject({ durationOk: true, tracksOk: true, decodeOk: true, verified: true });

    const plan = planMove({
      hostId: "pc-agent",
      os: "win32",
      name: "Interstellar",
      sourcePath: "D:\\фильмы\\Interstellar.mkv",
      destinationPath: "D:\\фильмы\\Interstellar.av1.mkv",
    });
    const verified = { ...plan, phase: "verified" as const, verified: true };
    expect(confirmSourceDelete(verified, false).deleteSource).toBe(false);
    expect(confirmSourceDelete(verified, true)).toMatchObject({ deleteSource: true, sourceDeleted: false });
  });

  it("leases the shared hub to both workers and drops a Z: source before HandBrake starts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-hub-"));
    dirs.push(dir);
    const host = localJobHost();
    expect(host).toBeTruthy();
    const source = path.join(dir, "clip.mkv");
    await writeFile(source, "clip-bytes");
    const store = createJobStore(dir);
    const forbidden = await store.enqueue({
      kind: "transcode",
      host: host!,
      source: "Z:\\фильмы\\secret.mkv",
      destination: "Z:\\фильмы\\secret.av1.mkv",
      handbrakeProfile: "c:h264:sw",
    });
    const good = await store.enqueue({
      kind: "transcode",
      host: host!,
      source,
      destination: path.join(dir, "clip.av1.mkv"),
      handbrakeProfile: "c:h264:sw",
    });
    const hub = await startEncodeHub({ token: "emulation-hub-token", directory: dir });
    try {
      const auth = { authorization: "Bearer emulation-hub-token", "content-type": "application/json" };
      for (const worker of [
        { id: "win-hb", role: "pc", platform: "win32" },
        { id: "mac-hb", role: "mac", platform: "darwin" },
      ]) {
        const registered = await fetch(`http://127.0.0.1:${hub.port}/v1/workers`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ ...worker, encoders: ["x264", "svt_av1"], slots: 1, freeBytes: 64 * 1024 * 1024 }),
        });
        expect(registered.status).toBe(200);
      }
      const first = await claim(hub.port, "win-hb");
      expect(first.job?.jobId).toBe(good.job.id);
      expect(first.job?.sourceSha256).toBe(createHash("sha256").update(await readFile(source)).digest("hex"));
      const second = await claim(hub.port, "mac-hb");
      expect(second.job).toBeNull();
      const dropped = await store.get(forbidden.job.id);
      expect(dropped?.state).toBe("error");
      expect(dropped?.cancelled).toBe(true);
      expect(JSON.stringify(dropped)).not.toContain("secret-ledger");
    } finally {
      await hub.close();
    }
  });
});

async function claim(port: number, id: string): Promise<{ job: { jobId: string; sourceSha256: string } | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/claim`, {
    method: "POST",
    headers: { authorization: "Bearer emulation-hub-token", "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return response.json() as Promise<{ job: { jobId: string; sourceSha256: string } | null }>;
}

async function waitHash(id: string) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const job = await getIntegrityJob(id);
    if (job && (job.state === "done" || job.state === "error")) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`hash job ${id} did not finish`);
}
