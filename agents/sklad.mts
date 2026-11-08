import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createJobStore } from "../src/lib/jobs/engine.ts";
import { dataDir } from "../src/lib/qbittorrent/store.ts";
import { ingestSnapshot, parseSnapshotFixture, verifySnapshotJob } from "../src/lib/service/snapshot-pipeline.ts";

interface Reply {
  ok: boolean;
  command: string;
  [key: string]: unknown;
}

const args = process.argv.slice(2);
const json = args.includes("--json") || args[0] !== "help";
const positionals = args.filter((arg) => !arg.startsWith("--"));
const command = positionals[0] ?? "help";
const sub = positionals[1] ?? "";

function emit(status: number, body: Reply): never {
  const text = JSON.stringify(body);
  if (json || status !== 0) process.stdout.write(`${text}\n`);
  process.exit(status);
}

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function pidFile(): string {
  return path.join(dataDir(), "sklad-service.pid");
}

async function serviceAlive(): Promise<{ running: boolean; pid: number | null }> {
  try {
    const pid = Number((await readFile(pidFile(), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null };
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      const pid = Number((await readFile(pidFile(), "utf8")).trim());
      return { running: true, pid };
    }
    return { running: false, pid: null };
  }
}

async function main(): Promise<void> {
  if (command === "help") {
    const body: Reply = {
      ok: true,
      command: "help",
      wiztree: "offline-file",
      commands: ["help", "ingest", "mft-import", "mft-status", "mft-cancel", "catalog", "status", "work", "policy", "encode", "service"],
      service: ["start", "status", "stop", "run"],
      jsonStdout: "npm --silent run sklad -- <command> --json",
    };
    if (!json) {
      process.stdout.write("sklad ingest|mft-import|mft-status|mft-cancel|catalog|status|work|policy|encode|service\n");
    }
    emit(0, body);
  }
  if (command === "ingest") {
    const file = flag("--fixture");
    if (!file) emit(2, { ok: false, command, error: "Нужен --fixture." });
    if (file.toLowerCase().endsWith(".mft")) {
      emit(3, { ok: false, command, wiztree: false, error: "Импорт WizTree MFT не подключён." });
    }
    let fixture;
    try {
      fixture = parseSnapshotFixture(JSON.parse(await readFile(file, "utf8")) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Снимок не прочитан.";
      emit(message.includes("WizTree") || message.includes("E и Z") ? 3 : 2, { ok: false, command, wiztree: false, error: message });
    }
    const result = await ingestSnapshot(fixture);
    emit(0, { ok: true, command, wiztree: false, ...result });
  }
  if (command === "mft-import" || command === "mft-status" || command === "mft-cancel") {
    const mft = await import("../src/lib/service/mft-import.ts");
    if (command === "mft-cancel") {
      await mft.requestMftCancel();
      emit(0, { ok: true, command, cancelled: true, ready: false });
    }
    if (command === "mft-status") {
      const progress = await mft.readMftProgress();
      emit(0, { ok: true, command, progress, ready: progress?.ready === true });
    }
    const file = flag("--file");
    const serial = flag("--serial");
    const volumeUuid = flag("--uuid");
    if (!file || !serial || !volumeUuid) emit(2, { ok: false, command, error: "Нужны --file, --serial и --uuid. Буква и размер тома диском не являются." });
    try {
      await mft.clearMftCancel();
      const result = await mft.importMftExport({ filePath: file, serial, volumeUuid });
      emit(0, { ok: true, command, wiztree: "offline-file", live: false, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Импорт MFT не выполнился.";
      emit(message.includes("E и F") ? 3 : 1, { ok: false, command, ready: false, error: message });
    }
  }
  if (command === "catalog") {
    const disks = await readDisks();
    emit(0, {
      ok: true,
      command,
      scanned: false,
      wiztree: "offline-file",
      disks: disks.map((disk) => ({
        id: disk.id,
        label: disk.label,
        online: Array.isArray(disk.connectedHosts) && disk.connectedHosts.length > 0,
        files: disk.summary?.fileCount ?? disk.files?.length ?? 0,
        indexedBytes: disk.summary?.indexedBytes ?? 0,
      })),
    });
  }
  if (command === "status") {
    const alive = await serviceAlive();
    const store = createJobStore(dataDir());
    const list = await store.list({ limit: 100 });
    emit(0, {
      ok: true,
      command,
      service: alive,
      counts: list.counts,
      jobs: list.jobs.map((job) => ({ id: job.id, kind: job.kind, state: job.state, verified: job.verified, diskId: job.payload.diskId })),
    });
  }
  if (command === "work" && sub === "--once" || (command === "work" && args.includes("--once"))) {
    const result = await verifySnapshotJob(createJobStore(dataDir()));
    emit(0, { ok: true, command: "work", ...result });
  }
  if (command === "policy") {
    const db = await import("../src/lib/compact-db/database.ts");
    const { GAME_POOL_PIN } = await import("../src/lib/policies/storage-roles.ts");
    const steam = Number(flag("--steam"));
    const algorithm = flag("--algorithm");
    let compact: unknown = { state: "unconfigured", source: db.COMPACT_DB_URL, license: "CompactGUI program is GPL-3.0. database.json has no separate license notice; it is not treated as automatically outside the GPL and is not vendored." };
    if (Number.isInteger(steam) && steam > 0 && algorithm) {
      compact = db.lookupCompactResult(db.cacheFromText("[]", null), steam, algorithm as "XPRESS4K" | "XPRESS8K" | "XPRESS16K" | "LZX");
    }
    emit(0, {
      ok: true,
      command,
      pin: GAME_POOL_PIN,
      wiztree: false,
      compact,
      encode: { state: "blocked", backend: "HandBrakeCLI", started: false, reason: "Кодирование не запускалось. Аппаратный AV1 не заявлен без пробы." },
      retirement: { applied: false, rule: "verified durable output AND (ratio >= 3 OR 72h wall clock from completion)" },
    });
  }
  if (command === "encode") {
    const encode = await import("../src/lib/transcode/encode-worker.ts");
    if (sub === "probe") {
      const probe = await encode.probeEncoder();
      emit(probe.present ? 0 : 3, { ...probe, ok: probe.present, command, action: "probe", started: false });
    }
    if (sub === "work") {
      const result = await encode.runEncodeOnce();
      emit(0, { ...result, ok: true, command, action: "work" });
    }
    if (sub === "cancel") {
      const id = flag("--id");
      if (!id) emit(2, { ok: false, command, error: "Нужен --id." });
      const job = await createJobStore(dataDir()).cancel(id);
      emit(0, { ok: true, command, action: "cancel", jobId: job.id, state: job.state, verified: false, ready: false });
    }
    const source = flag("--source");
    const destination = flag("--dest");
    const codec = flag("--codec");
    if (!source || !destination || (codec !== "av1" && codec !== "hevc" && codec !== "h264")) {
      emit(2, { ok: false, command, started: false, error: "Нужны --source, --dest и явный --codec av1|hevc|h264. H.264 сам не выбирается." });
    }
    const queued = await encode.enqueueEncode({
      source,
      destination,
      codec,
      allowSoftware: !args.includes("--hardware-only"),
      ...(flag("--torrent") ? { torrentHash: flag("--torrent")! } : {}),
    });
    if (!queued.ok) emit(3, { ...queued, ok: false, command, started: false });
    if (sub === "run") {
      const result = await encode.runEncodeOnce();
      emit(result.verified === true ? 0 : 1, { ...result, ok: result.verified === true, command, action: "run", enqueue: queued });
    }
    emit(0, { ...queued, ok: true, command, action: "enqueue" });
  }
  if (command === "service") {
    if (sub === "run") return serviceRun();
    if (sub === "start") return serviceStart();
    if (sub === "stop") return serviceStop();
    if (sub === "status") {
      emit(0, { ok: true, command: "service", ...(await serviceAlive()) });
    }
    emit(2, { ok: false, command, error: "service: start, status, stop." });
  }
  emit(2, { ok: false, command, error: "Неизвестная команда. sklad help" });
}

async function serviceStart(): Promise<void> {
  const alive = await serviceAlive();
  if (alive.running) emit(0, { ok: true, command: "service", action: "start", already: true, pid: alive.pid });
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", "service", "run"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const next = await serviceAlive();
    if (next.running) emit(0, { ok: true, command: "service", action: "start", already: false, pid: next.pid });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  emit(1, { ok: false, command: "service", action: "start", error: "Служба не записала pid." });
}

async function serviceStop(): Promise<void> {
  const alive = await serviceAlive();
  if (!alive.running || !alive.pid) {
    await rm(pidFile(), { force: true });
    emit(0, { ok: true, command: "service", action: "stop", stopped: true, pid: null });
  }
  process.kill(alive.pid, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const next = await serviceAlive();
    if (!next.running) {
      await rm(pidFile(), { force: true });
      emit(0, { ok: true, command: "service", action: "stop", stopped: true, pid: alive.pid });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { process.kill(alive.pid, "SIGKILL"); } catch { /* already gone */ }
  await rm(pidFile(), { force: true });
  emit(0, { ok: true, command: "service", action: "stop", stopped: true, pid: alive.pid });
}

async function serviceRun(): Promise<void> {
  await writeFile(pidFile(), String(process.pid), "utf8");
  let stop = false;
  const finish = () => { stop = true; };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  while (!stop) {
    const result = await verifySnapshotJob(createJobStore(dataDir()));
    const encode = await import("../src/lib/transcode/encode-worker.ts");
    const encoded = await encode.runEncodeOnce(dataDir()).catch(() => ({ processed: false }));
    if (!result.processed && !encoded.processed) await new Promise((resolve) => setTimeout(resolve, Number(process.env.SKLAD_SERVICE_TICK_MS || 200)));
  }
  await rm(pidFile(), { force: true });
  process.exit(0);
}

async function readDisks(): Promise<Array<{ id: string; label: string; connectedHosts?: unknown[]; files?: unknown[]; summary?: { fileCount?: number; indexedBytes?: number } }>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir(), "drives.json"), "utf8")) as { disks?: unknown[] };
    return Array.isArray(parsed.disks) ? parsed.disks as Array<{ id: string; label: string; connectedHosts?: unknown[]; files?: unknown[]; summary?: { fileCount?: number; indexedBytes?: number } }> : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Сбой команды.";
  emit(1, { ok: false, command, error: message });
});
