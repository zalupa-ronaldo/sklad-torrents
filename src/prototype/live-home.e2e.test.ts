import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { withDevFlag } from "@/prototype/serve-home";

const root = path.join(process.cwd(), "public", "prototype");
const disk = {
  id: "disk-live",
  label: "Vault Live",
  filesystem: "APFS",
  totalBytes: 1000,
  freeBytes: 100,
  online: true,
  lastSeenAt: "2026-11-18T00:00:00.000Z",
  lastHostId: "mac-mini",
  lastHostName: "Mac Live",
  mountPaths: ["/Volumes/Vault Live"],
  lastMountPath: "/Volumes/Vault Live",
  fileCount: 1,
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function devtoolsPort(directory: string, chrome: ChildProcess): Promise<number> {
  let stderr = "";
  chrome.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (chrome.exitCode !== null) break;
    const text = await readFile(path.join(directory, "DevToolsActivePort"), "utf8").catch(() => "");
    const port = Number(text.split("\n")[0]);
    if (port) return port;
    await sleep(100);
  }
  chrome.kill();
  throw new Error(stderr.trim() || "chrome did not open a debugging port");
}

describe("live home page", () => {
  let chrome: ChildProcess | null = null;
  let server: Server | null = null;

  afterEach(async () => {
    chrome?.kill();
    chrome = null;
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it("loads without demo, calls the panel API, and shows a host or a drive", async () => {
    const hits: string[] = [];
    server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      hits.push(url.pathname);
      if (url.pathname === "/") {
        const html = withDevFlag(await readFile(path.join(root, "index.html"), "utf8"), "production");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (url.pathname.startsWith("/prototype/")) {
        const name = decodeURIComponent(url.pathname.slice("/prototype/".length)).split("?")[0] || "";
        const file = path.normalize(path.join(root, name));
        if (!file.startsWith(root)) {
          response.writeHead(403).end();
          return;
        }
        const body = await readFile(file).catch(() => null);
        if (!body) {
          response.writeHead(404).end();
          return;
        }
        const type = file.endsWith(".css") ? "text/css" : "text/javascript";
        response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        response.end(body);
        return;
      }
      if (url.pathname === "/api/drives") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ disks: [disk], agentErrors: [] }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(404).end();
    });
    const port = await listen(server);
    const profile = await mkdtemp(path.join(os.tmpdir(), "sklad-chrome-"));
    chrome = spawn(
      "google-chrome",
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const debug = await devtoolsPort(profile, chrome);
    const target = (await (await fetch(`http://127.0.0.1:${debug}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: "PUT" })).json()) as {
      webSocketDebuggerUrl?: string;
    };
    const pageSocket = target.webSocketDebuggerUrl;
    if (!pageSocket) throw new Error("chrome did not open the home page");
    const page = new WebSocket(pageSocket);
    await new Promise<void>((resolve, reject) => {
      page.addEventListener("open", () => resolve());
      page.addEventListener("error", () => reject(new Error("page socket failed")));
    });
    let pageCall = 0;
    const pageWaiters = new Map<number, (value: { result?: { result?: { value?: string } } }) => void>();
    page.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: string } } };
      if (message.id) pageWaiters.get(message.id)?.(message);
    });
    const pageSend = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++pageCall;
      page.send(JSON.stringify({ id, method, params }));
      return new Promise<{ result?: { result?: { value?: string } } }>((resolve) => pageWaiters.set(id, resolve));
    };
    await pageSend("Runtime.enable");
    let text = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const evaluated = await pageSend("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
      text = evaluated.result?.result?.value || "";
      if (hits.some((item) => item.startsWith("/api/")) && /Mac Live|Vault Live/.test(text)) break;
      await sleep(200);
    }
    page.close();
    expect(hits.some((item) => item.startsWith("/api/"))).toBe(true);
    expect(text).toMatch(/Mac Live|Vault Live/);
  }, 40_000);
});
