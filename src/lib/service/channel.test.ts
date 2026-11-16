import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { POST as claimPost } from "@/app/api/agent-claim/route";
import { GET as linkGet } from "@/app/api/hosts/link/route";
import { POST as testPost } from "@/app/api/hosts/test/route";
import { createJobStore } from "@/lib/jobs/engine";
import { createHost, getHost } from "@/lib/qbittorrent/store";
import { applyHeartbeat, channelPullUrl, parseChannelBody, tickChannel } from "@/lib/service/channel";
import { CHANNEL_TEXT, emptyChannel, overlayHostError, reconcile, type HeartbeatInput } from "@/lib/service/channel-view";
import { dispatchOnce } from "@/lib/service/dispatch";

const previousData = process.env.SKLAD_DATA_DIR;
const previousHost = process.env.SKLAD_QB_CHANNEL_HOST_ID;
const previousReal = process.env.SKLAD_REAL_ONLY;
const dirs: string[] = [];

afterEach(async () => {
  restore("SKLAD_DATA_DIR", previousData);
  restore("SKLAD_QB_CHANNEL_HOST_ID", previousHost);
  restore("SKLAD_REAL_ONLY", previousReal);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("says the Windows agent is missing until it checks in", async () => {
  const dir = await tempDir();
  const link = await tickChannel(dir, 1_000);
  expect(link.state).toBe("down");
  expect(link.peers["pc-agent"]).toEqual({
    qbittorrent: "down",
    handbrake: "down",
    detail: CHANNEL_TEXT.agentMissing,
  });
  expect(link.peers["mac-local"].detail).toBeNull();
});

it("starts socat and the port forward on the first heartbeat", async () => {
  const now = 5_000;
  const { file, actions } = reconcile(emptyChannel(now), heartbeat({ socatOk: false, portproxyOk: false }), now);
  expect(file.repairing).toBe(true);
  expect(actions.map((action) => action.op)).toEqual(["start-socat", "ensure-portproxy"]);
  expect(actions[0]).toMatchObject({ listenHost: "127.0.0.1", listenPort: 18080, wslIp: "10.0.0.8", wslPort: 8080 });
  expect(actions[1]).toMatchObject({ listenHost: "0.0.0.0", listenPort: 18080, connectHost: "127.0.0.1", connectPort: 18080 });
  const link = await applyHeartbeat(heartbeat({ socatOk: false, portproxyOk: false }), await tempDir(), now);
  expect(link.link.state).toBe("recovering");
  expect(link.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.socatDown);
});

it("restarts only socat when the WSL address changes and keeps the port forward", async () => {
  const dir = await tempDir();
  const now = 10_000;
  await applyHeartbeat(heartbeat(), dir, now);
  const changed = await applyHeartbeat(heartbeat({ wslIp: "10.0.0.9", qbittorrentOk: false }), dir, now + 1_000);
  expect(changed.actions.map((action) => action.op)).toEqual(["restart-socat"]);
  expect(changed.actions[0]).toMatchObject({ wslIp: "10.0.0.9" });
  expect(changed.link.state).toBe("recovering");
  expect(changed.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.wslIpChanged);
  const still = await applyHeartbeat(heartbeat({ wslIp: "10.0.0.9", socatOk: false, qbittorrentOk: false }), dir, now + 2_000);
  expect(still.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.wslIpChanged);
  expect(still.actions.some((action) => action.op === "ensure-portproxy")).toBe(false);
  const healed = await applyHeartbeat(heartbeat({ wslIp: "10.0.0.9" }), dir, now + 3_000);
  expect(healed.actions).toEqual([]);
  expect(healed.link.state).toBe("up");
  expect(healed.link.peers["pc-agent"].detail).toBeNull();
});

it("names a missing port forward, a silent qBittorrent, and a silent HandBrake", async () => {
  const dir = await tempDir();
  const now = 20_000;
  const forward = await applyHeartbeat(heartbeat({ portproxyOk: false }), dir, now);
  expect(forward.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.portproxyMissing);
  expect(forward.actions.map((action) => action.op)).toEqual(["ensure-portproxy"]);
  const qb = await applyHeartbeat(heartbeat({ qbittorrentOk: false }), dir, now + 1_000);
  expect(qb.link.state).toBe("recovering");
  expect(qb.actions.map((action) => action.op)).toEqual(["restart-socat"]);
  expect(qb.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.qbittorrentDown);
  const again = await applyHeartbeat(heartbeat({ qbittorrentOk: false }), dir, now + 2_000);
  expect(again.actions).toEqual([]);
  expect(again.link.state).toBe("down");
  const handbrake = await applyHeartbeat(heartbeat({ handbrakeOk: false }), dir, now + 3_000);
  expect(handbrake.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.handbrakeDown);
  expect(handbrake.actions).toEqual([]);
  const mac = await applyHeartbeat(heartbeat({ macHandbrakeOk: false }), dir, now + 4_000);
  expect(mac.link.peers["mac-local"]).toMatchObject({ handbrake: "down", detail: CHANNEL_TEXT.handbrakeDown });
  expect(mac.link.peers["pc-agent"].detail).toBeNull();
  expect(mac.link.state).toBe("down");
});

it("drops the Windows peer after 30 seconds without inventing a repair", async () => {
  const dir = await tempDir();
  const now = 30_000;
  await applyHeartbeat(heartbeat(), dir, now);
  const link = await tickChannel(dir, now + 30_001);
  expect(link.state).toBe("down");
  expect(link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.agentMissing);
});

it("keeps a paused job paused across a link drop, a service tick, and a new process", async () => {
  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  const store = createJobStore(dir);
  const created = await store.enqueue({
    kind: "copy",
    host: "pc-agent",
    source: "/tmp/channel-src.bin",
    destination: "/tmp/channel-dst.bin",
  });
  const claim = await store.claim(created.job.id, "pc-agent");
  expect(claim.ok).toBe(true);
  if (!claim.ok) return;
  await store.updateProgress(created.job.id, claim.job.workerToken || "", {
    percent: 40,
    processedBytes: 4096,
    totalBytes: 8192,
    speed: 100,
    etaSeconds: 40,
    currentFile: "channel-src.bin",
  });
  await store.pause(created.job.id);
  const now = 40_000;
  await applyHeartbeat(heartbeat({ socatOk: false }), dir, now);
  await tickChannel(dir, now + 31_000);
  await dispatchOnce(dir);
  const reloaded = createJobStore(dir);
  const job = await reloaded.get(created.job.id);
  expect(job?.state).toBe("paused");
  expect(job?.progress.processedBytes).toBe(4096);
  expect(job?.progress.currentFile).toBe("channel-src.bin");
  expect(job?.workerToken).toBeNull();
});

it("pins a raw WSL address to the stable URL once and does not store the password", async () => {
  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  process.env.SKLAD_REAL_ONLY = "1";
  const host = await createHost({
    name: "Windows qBittorrent",
    baseUrl: "http://10.1.0.5:8080",
    username: "qb",
    password: "secret-password",
    os: "win32",
  });
  process.env.SKLAD_QB_CHANNEL_HOST_ID = host.id;
  const now = 50_000;
  await applyHeartbeat(heartbeat({ wslIp: "10.1.0.5", stableBaseUrl: "http://192.168.1.40:18080" }), dir, now);
  expect((await getHost(host.id))?.baseUrl).toBe("http://192.168.1.40:18080");
  const raw = await readFile(path.join(dir, "channel.json"), "utf8");
  expect(raw).not.toContain("secret-password");
  expect(raw).not.toContain("Z:");
  const mode = (await stat(path.join(dir, "channel.json"))).mode & 0o777;
  expect(mode).toBe(0o600);
  await applyHeartbeat(heartbeat({ wslIp: "10.1.0.5", stableBaseUrl: "http://192.168.1.40:18080" }), dir, now + 1_000);
  expect((await getHost(host.id))?.baseUrl).toBe("http://192.168.1.40:18080");
});

it("does not rewrite a qBittorrent URL that is not the WSL address", async () => {
  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  process.env.SKLAD_REAL_ONLY = "1";
  const host = await createHost({
    name: "Other",
    baseUrl: "http://10.9.9.9:8080",
    username: "qb",
    password: "secret-password",
    os: "win32",
  });
  process.env.SKLAD_QB_CHANNEL_HOST_ID = host.id;
  await applyHeartbeat(heartbeat({ wslIp: "10.1.0.5", stableBaseUrl: "http://192.168.1.40:18080" }), dir, 60_000);
  expect((await getHost(host.id))?.baseUrl).toBe("http://10.9.9.9:8080");
});

it("shows the channel sentence in the host list and in the connection test", async () => {
  const replaced = overlayHostError(
    { os: "win32", online: false, error: "Хост недоступен. Проверьте адрес и что Web UI включён." },
    {
      state: "down",
      peers: {
        "mac-local": { qbittorrent: "up", handbrake: "up", detail: null },
        "pc-agent": { qbittorrent: "down", handbrake: "up", detail: CHANNEL_TEXT.wslIpChanged },
      },
    },
  );
  expect(replaced.error).toBe(CHANNEL_TEXT.wslIpChanged);

  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  await applyHeartbeat(
    heartbeat({ socatOk: false, stableBaseUrl: "http://127.0.0.1:59999" }),
    dir,
    Date.now(),
  );
  const response = await testPost(new Request("http://panel.local/api/hosts/test", {
    method: "POST",
    body: JSON.stringify({ baseUrl: "http://127.0.0.1:59999", username: "qb", password: "x" }),
  }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: CHANNEL_TEXT.socatDown });
});

it("keeps job claim and does not take a paused or queued job from a channel heartbeat", async () => {
  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  const store = createJobStore(dir);
  const queued = await store.enqueue({
    kind: "copy",
    host: "pc-agent",
    source: "/tmp/channel-queued.bin",
    destination: "/tmp/channel-queued-out.bin",
  });
  await store.pause((await store.enqueue({
    kind: "copy",
    host: "pc-agent",
    source: "/tmp/channel-paused.bin",
    destination: "/tmp/channel-paused-out.bin",
  })).job.id);

  const beat = await claimPost(new Request("http://panel.local/api/agent-claim", {
    method: "POST",
    body: JSON.stringify({ role: "channel", host: "pc-agent", ...heartbeat({ socatOk: false }) }),
  }));
  expect(beat.status).toBe(200);
  const body = await beat.json() as {
    actions: { op: string }[];
    link: { state: string; peers: { "pc-agent": { detail: string; qbittorrent: string } } };
  };
  expect(body.link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.socatDown);
  expect(body.link.peers["pc-agent"].qbittorrent).toBe("down");
  expect(body.link.state).toBe("recovering");
  expect(body.actions.map((action) => action.op)).toContain("start-socat");
  expect((await store.get(queued.job.id))?.state).toBe("queued");

  const claimed = await claimPost(new Request("http://panel.local/api/agent-claim", {
    method: "POST",
    body: JSON.stringify({ host: "pc-agent" }),
  }));
  expect(claimed.status).toBe(200);
  const job = await claimed.json() as { job: { id: string; state: string } };
  expect(job.job.id).toBe(queued.job.id);
  expect(job.job.state).toBe("running");

  const rejected = await claimPost(new Request("http://panel.local/api/agent-claim", {
    method: "POST",
    body: JSON.stringify({ role: "channel", worker: "mac-local" }),
  }));
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: CHANNEL_TEXT.agentMissing });
  expect(parseChannelBody({ host: "pc-agent" })).toBeNull();
});

it("serves the link status the panel reads", async () => {
  const dir = await tempDir();
  process.env.SKLAD_DATA_DIR = dir;
  const response = await linkGet();
  expect(response.status).toBe(200);
  const body = await response.json() as { state: string; peers: { "pc-agent": { detail: string } } };
  expect(body.state).toBe("down");
  expect(body.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.agentMissing);
});

it("pulls the heartbeat from the Windows agent when none was pushed", async () => {
  const dir = await tempDir();
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => ({ role: "channel", ...heartbeat() }) };
  };
  const link = await tickChannel(dir, 10_000, { pullUrl: "http://192.168.0.16:4730/v1/channel", fetchImpl });
  expect(calls).toEqual(["http://192.168.0.16:4730/v1/channel"]);
  expect(link.state).toBe("up");
  expect(link.peers["pc-agent"].qbittorrent).toBe("up");
  const again = await tickChannel(dir, 12_000, { pullUrl: "http://192.168.0.16:4730/v1/channel", fetchImpl });
  expect(calls).toHaveLength(1);
  expect(again.state).toBe("up");
});

it("keeps the link down when the agent cannot be pulled", async () => {
  const dir = await tempDir();
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const link = await tickChannel(dir, 10_000, { pullUrl: "http://192.168.0.16:4730/v1/channel", fetchImpl });
  expect(link.state).toBe("down");
  expect(link.peers["pc-agent"].detail).toBe(CHANNEL_TEXT.agentMissing);
});

it("builds the pull address only from an http agent URL", () => {
  expect(channelPullUrl({ SKLAD_PC_AGENT_URL: "http://192.168.0.16:4730" } as NodeJS.ProcessEnv)).toBe("http://192.168.0.16:4730/v1/channel");
  expect(channelPullUrl({} as NodeJS.ProcessEnv)).toBeNull();
  expect(channelPullUrl({ SKLAD_PC_AGENT_URL: "file:///etc" } as NodeJS.ProcessEnv)).toBeNull();
});

function heartbeat(patch: Partial<HeartbeatInput> = {}): HeartbeatInput {
  return {
    worker: "pc-agent" as const,
    wslIp: "10.0.0.8",
    socatOk: true,
    portproxyOk: true,
    qbittorrentOk: true,
    handbrakeOk: true,
    macQbittorrentOk: true,
    macHandbrakeOk: true,
    ...patch,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-channel-"));
  dirs.push(dir);
  return dir;
}

function restore(name: "SKLAD_DATA_DIR" | "SKLAD_QB_CHANNEL_HOST_ID" | "SKLAD_REAL_ONLY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
