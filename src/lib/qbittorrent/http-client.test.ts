import { afterEach, describe, expect, it } from "vitest";

import { multipartField, startFakeQbittorrent, type FakeQbittorrent } from "@/lib/qbittorrent/fake-server";
import { HttpQbittorrentClient } from "@/lib/qbittorrent/http-client";
import { QbittorrentError } from "@/lib/qbittorrent/errors";

const HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAGNET = `magnet:?xt=urn:btih:${"c".repeat(40)}&dn=Vault%20Game`;

describe("qBittorrent HTTP adapter", () => {
  const servers: FakeQbittorrent[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function boot(options?: Parameters<typeof startFakeQbittorrent>[0]) {
    const server = await startFakeQbittorrent(options);
    servers.push(server);
    return server;
  }

  it("logs in, sends the session cookie and Referer, and maps torrents", async () => {
    const fake = await boot({
      webapiVersion: "2.8.19",
      appVersion: "v4.6.7",
      savePath: "D:\\Downloads",
      torrents: [
        {
          hash: HASH,
          name: "Fixture Movie",
          state: "stoppedDL",
          progress: 0.5,
          size: 1000,
          total_size: 2000,
          save_path: "D:\\Downloads",
          content_path: "D:\\Downloads\\Fixture Movie",
          tags: "films",
          eta: 8640000,
        },
      ],
      files: {
        [HASH]: [{ index: 0, name: "Fixture Movie/movie.mkv", size: 1000, progress: 0.5, priority: 1 }],
      },
    });
    const client = new HttpQbittorrentClient(fake.url, "admin", "secret");
    const torrents = await client.listTorrents();
    expect(torrents[0]).toMatchObject({
      name: "Fixture Movie",
      state: "paused",
      savePath: "D:\\Downloads",
      contentPath: "D:\\Downloads\\Fixture Movie",
    });
    const info = fake.calls.find((call) => call.path.startsWith("/api/v2/torrents/info"));
    expect(info?.referer).toBe(`${fake.url}/`);
    expect(info?.origin).toBe("");
    expect(info?.cookie).toContain("SID=sid-a");
    const files = await client.listFiles(HASH);
    expect(files[0].name).toBe("Fixture Movie/movie.mkv");
    const probe = await client.probe();
    expect(probe).toMatchObject({ appVersion: "v4.6.7", webapiVersion: "2.8.19", defaultSavePath: "D:\\Downloads" });
  });

  it("uses pause on WebAPI 2.8 and stop on 2.11, with a 404 fallback", async () => {
    const legacy = await boot({ webapiVersion: "2.8.19" });
    const legacyClient = new HttpQbittorrentClient(legacy.url, "admin", "secret");
    await legacyClient.pause([HASH]);
    expect(legacy.calls.some((call) => call.path === "/api/v2/torrents/pause")).toBe(true);
    expect(legacy.calls.some((call) => call.path === "/api/v2/torrents/stop")).toBe(false);

    const modern = await boot({ webapiVersion: "2.11.2", stopNotFound: true });
    const modernClient = new HttpQbittorrentClient(modern.url, "admin", "secret");
    await modernClient.resume([HASH]);
    expect(modern.calls.map((call) => call.path)).toContain("/api/v2/torrents/start");
    await modernClient.pause([HASH]);
    expect(modern.calls.map((call) => call.path)).toEqual(
      expect.arrayContaining(["/api/v2/torrents/stop", "/api/v2/torrents/pause"]),
    );
  });

  it("posts a magnet to savepath and uses stopped=true on qBittorrent 5", async () => {
    const fake = await boot({ webapiVersion: "2.11.2" });
    const client = new HttpQbittorrentClient(fake.url, "admin", "secret");
    await client.add({
      urls: MAGNET,
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      paused: true,
    });
    const add = fake.calls.find((call) => call.path === "/api/v2/torrents/add");
    expect(add?.contentType).toContain("multipart/form-data");
    expect(multipartField(add?.body || "", "urls")).toBe(MAGNET);
    expect(multipartField(add?.body || "", "savepath")).toBe("/Volumes/vault/PSP/Games/Downloads");
    expect(multipartField(add?.body || "", "stopped")).toBe("true");
    expect(add?.body.includes('name="paused"')).toBe(false);
  });

  it("uses paused=true on qBittorrent 4 and posts setLocation plus file priority", async () => {
    const fake = await boot({ webapiVersion: "2.9.3" });
    const client = new HttpQbittorrentClient(fake.url, "admin", "secret");
    await client.add({ urls: MAGNET, savePath: "D:\\Downloads", paused: true });
    const add = fake.calls.find((call) => call.path === "/api/v2/torrents/add");
    expect(multipartField(add?.body || "", "paused")).toBe("true");
    await client.setLocation([HASH], "E:\\Cinema");
    const move = fake.calls.find((call) => call.path === "/api/v2/torrents/setLocation");
    expect(new URLSearchParams(move?.body || "").get("location")).toBe("E:\\Cinema");
    expect(new URLSearchParams(move?.body || "").get("hashes")).toBe(HASH);
    await client.setFilePriority(HASH, [0, 1], 0);
    const prio = fake.calls.find((call) => call.path === "/api/v2/torrents/filePrio");
    const params = new URLSearchParams(prio?.body || "");
    expect(params.get("id")).toBe("0|1");
    expect(params.get("priority")).toBe("0");
    await client.remove([HASH], true);
    const remove = fake.calls.find((call) => call.path === "/api/v2/torrents/delete");
    expect(new URLSearchParams(remove?.body || "").get("deleteFiles")).toBe("true");
  });

  it("rejects a bad password before listing torrents", async () => {
    const fake = await boot();
    const client = new HttpQbittorrentClient(fake.url, "admin", "nope");
    await expect(client.listTorrents()).rejects.toBeInstanceOf(QbittorrentError);
    await expect(client.listTorrents()).rejects.toMatchObject({ code: "auth" });
    expect(fake.calls.some((call) => call.path.startsWith("/api/v2/torrents/info"))).toBe(false);
  });

  it("logs in again when qBittorrent drops the session", async () => {
    const fake = await boot({ rotateSid: true });
    const client = new HttpQbittorrentClient(fake.url, "admin", "secret");
    await expect(client.listTorrents()).resolves.toEqual([]);
    const logins = fake.calls.filter((call) => call.path === "/api/v2/auth/login");
    expect(logins).toHaveLength(2);
    const infos = fake.calls.filter((call) => call.path.startsWith("/api/v2/torrents/info"));
    expect(infos.at(-1)?.cookie).toContain("SID=sid-b");
  });
});
