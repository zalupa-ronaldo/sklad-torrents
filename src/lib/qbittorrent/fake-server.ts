import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { RawFile, RawTorrent } from "@/lib/qbittorrent/types";

export interface FakeCall {
  method: string;
  path: string;
  referer: string;
  origin: string;
  cookie: string;
  contentType: string;
  body: string;
}

export interface FakeQbittorrent {
  url: string;
  calls: FakeCall[];
  close: () => Promise<void>;
}

export async function startFakeQbittorrent(options?: {
  webapiVersion?: string;
  appVersion?: string;
  username?: string;
  password?: string;
  savePath?: string;
  torrents?: RawTorrent[];
  files?: Record<string, RawFile[]>;
  stopNotFound?: boolean;
  rotateSid?: boolean;
}): Promise<FakeQbittorrent> {
  const username = options?.username ?? "admin";
  const password = options?.password ?? "secret";
  const torrents = options?.torrents ?? [];
  const files = options?.files ?? {};
  let sid = "sid-a";
  let rotated = false;
  const calls: FakeCall[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = (await readBody(req)).toString("latin1");
    calls.push({
      method: req.method || "GET",
      path: `${url.pathname}${url.search}`,
      referer: String(req.headers.referer || ""),
      origin: String(req.headers.origin || ""),
      cookie: String(req.headers.cookie || ""),
      contentType: String(req.headers["content-type"] || ""),
      body,
    });

    if (url.pathname === "/api/v2/auth/login") {
      const params = new URLSearchParams(body);
      if (params.get("username") !== username || params.get("password") !== password) {
        text(res, 403, "Fails.");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Set-Cookie": `SID=${sid}; HttpOnly; Path=/`,
      });
      res.end("Ok.");
      return;
    }

    if (options?.rotateSid && url.pathname === "/api/v2/torrents/info" && !rotated) {
      rotated = true;
      sid = "sid-b";
      text(res, 403, "Forbidden");
      return;
    }

    const cookie = String(req.headers.cookie || "");
    if (!cookie.split(";").some((part) => part.trim() === `SID=${sid}`)) {
      text(res, 403, "Forbidden");
      return;
    }

    if (url.pathname === "/api/v2/app/version") {
      json(res, options?.appVersion ?? "v5.0.0");
      return;
    }
    if (url.pathname === "/api/v2/app/webapiVersion") {
      json(res, options?.webapiVersion ?? "2.11.2");
      return;
    }
    if (url.pathname === "/api/v2/app/preferences") {
      json(res, { save_path: options?.savePath ?? "D:\\Downloads" });
      return;
    }
    if (url.pathname === "/api/v2/torrents/info") {
      json(res, torrents);
      return;
    }
    if (url.pathname === "/api/v2/torrents/files") {
      json(res, files[url.searchParams.get("hash") || ""] ?? []);
      return;
    }
    if (url.pathname === "/api/v2/torrents/stop" && options?.stopNotFound) {
      text(res, 404, "Not Found");
      return;
    }
    if (
      url.pathname === "/api/v2/torrents/pause" ||
      url.pathname === "/api/v2/torrents/resume" ||
      url.pathname === "/api/v2/torrents/stop" ||
      url.pathname === "/api/v2/torrents/start" ||
      url.pathname === "/api/v2/torrents/delete" ||
      url.pathname === "/api/v2/torrents/setLocation" ||
      url.pathname === "/api/v2/torrents/filePrio" ||
      url.pathname === "/api/v2/torrents/add"
    ) {
      text(res, 200, "Ok.");
      return;
    }
    text(res, 404, "Not Found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function multipartField(body: string, name: string): string | null {
  const marker = `name="${name}"`;
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const start = body.indexOf("\r\n\r\n", at);
  if (start < 0) return null;
  const end = body.indexOf("\r\n", start + 4);
  if (end < 0) return null;
  return body.slice(start + 4, end);
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
