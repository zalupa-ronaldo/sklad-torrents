import type { QbittorrentClient } from "@/lib/qbittorrent/client";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertHash, assertPriority } from "@/lib/qbittorrent/paths";
import { mapRawFile, mapRawTorrent, usesStopApi } from "@/lib/qbittorrent/state";
import type { AddTorrentInput, QbProbe, RawFile, RawTorrent, TorrentFileSnapshot, TorrentSnapshot } from "@/lib/qbittorrent/types";
import { normalizeBaseUrl } from "@/lib/qbittorrent/urls";

const TIMEOUT_MS = 8_000;

/**
 * Speaks the qBittorrent WebUI API (v2). qBittorrent 4.x uses pause/resume;
 * qBittorrent 5 (WebAPI >= 2.11) renamed those to stop/start.
 * Requests always send Referer/Origin so CSRF protection can stay enabled.
 */
export class HttpQbittorrentClient implements QbittorrentClient {
  readonly kind = "http" as const;
  private readonly root: string;
  private readonly origin: string;
  private cookie: string | null = null;
  private authed = false;
  private session: Promise<void> | null = null;
  private webapiVersion: string | null = null;
  private probeCache: { at: number; value: QbProbe } | null = null;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.root = normalizeBaseUrl(baseUrl);
    this.origin = new URL(this.root).origin;
  }

  async login(): Promise<void> {
    await this.ready();
  }

  async probe(): Promise<QbProbe> {
    if (this.probeCache && Date.now() - this.probeCache.at < 60_000) return this.probeCache.value;
    await this.ready();
    const [appVersion, webapiVersion, prefs] = await Promise.all([
      this.getJson<string>("/api/v2/app/version"),
      this.getJson<string>("/api/v2/app/webapiVersion"),
      this.getJson<{ save_path?: string }>("/api/v2/app/preferences"),
    ]);
    this.webapiVersion = String(webapiVersion);
    const value = {
      appVersion: String(appVersion),
      webapiVersion: String(webapiVersion),
      defaultSavePath: String(prefs.save_path ?? ""),
    };
    this.probeCache = { at: Date.now(), value };
    return value;
  }

  async listTorrents(): Promise<TorrentSnapshot[]> {
    await this.ready();
    const rows = await this.getJson<RawTorrent[]>("/api/v2/torrents/info");
    if (!Array.isArray(rows)) {
      throw new QbittorrentError("api", "Список раздач не распознан.");
    }
    return rows.map(mapRawTorrent);
  }

  async listFiles(hash: string): Promise<TorrentFileSnapshot[]> {
    const safe = assertHash(hash);
    await this.ready();
    const rows = await this.getJson<RawFile[]>(`/api/v2/torrents/files?hash=${safe}`);
    if (!Array.isArray(rows)) {
      throw new QbittorrentError("api", "Список файлов не распознан.");
    }
    return rows.map(mapRawFile);
  }

  async add(input: AddTorrentInput): Promise<{ hashes: string[] }> {
    await this.ready();
    const modern = usesStopApi(await this.webapi());
    const form = new FormData();
    if (input.urls?.trim()) form.append("urls", input.urls.trim());
    if (input.torrent) {
      const copy = new Uint8Array(input.torrent.data.byteLength);
      copy.set(input.torrent.data);
      form.append("torrents", new Blob([copy.buffer]), input.torrent.filename || "upload.torrent");
    }
    if (input.savePath) form.append("savepath", input.savePath);
    if (input.paused) form.append(modern ? "stopped" : "paused", "true");
    const res = await this.request("/api/v2/torrents/add", { method: "POST", body: form });
    await this.assertOk(res);
    return { hashes: [] };
  }

  async pause(hashes: string[]): Promise<void> {
    await this.toggle(hashes, "stop");
  }

  async resume(hashes: string[]): Promise<void> {
    await this.toggle(hashes, "start");
  }

  async remove(hashes: string[], deleteFiles: boolean): Promise<void> {
    const safe = this.requireHashes(hashes);
    await this.ready();
    await this.form("/api/v2/torrents/delete", {
      hashes: safe.join("|"),
      deleteFiles: deleteFiles ? "true" : "false",
    });
  }

  async setLocation(hashes: string[], location: string): Promise<void> {
    const safe = this.requireHashes(hashes);
    await this.ready();
    await this.form("/api/v2/torrents/setLocation", {
      hashes: safe.join("|"),
      location,
    });
  }

  async setFilePriority(hash: string, fileIds: number[], priority: number): Promise<void> {
    const safe = assertHash(hash);
    const level = assertPriority(priority);
    if (fileIds.length === 0) {
      throw new QbittorrentError("validation", "Не выбраны файлы.");
    }
    await this.ready();
    await this.form("/api/v2/torrents/filePrio", {
      hash: safe,
      id: fileIds.join("|"),
      priority: String(level),
    });
  }

  private async toggle(hashes: string[], mode: "stop" | "start"): Promise<void> {
    const safe = this.requireHashes(hashes);
    await this.ready();
    const modern = usesStopApi(await this.webapi());
    const primary =
      mode === "stop"
        ? modern
          ? "/api/v2/torrents/stop"
          : "/api/v2/torrents/pause"
        : modern
          ? "/api/v2/torrents/start"
          : "/api/v2/torrents/resume";
    const fallback =
      mode === "stop"
        ? modern
          ? "/api/v2/torrents/pause"
          : "/api/v2/torrents/stop"
        : modern
          ? "/api/v2/torrents/resume"
          : "/api/v2/torrents/start";
    await this.formPrefer(primary, fallback, { hashes: safe.join("|") });
  }

  private async webapi(): Promise<string> {
    if (this.webapiVersion) return this.webapiVersion;
    const version = await this.getJson<string>("/api/v2/app/webapiVersion");
    this.webapiVersion = String(version);
    return this.webapiVersion;
  }

  private ready(): Promise<void> {
    if (this.authed) return Promise.resolve();
    if (!this.session) {
      this.session = this.performLogin().catch((error) => {
        this.session = null;
        this.authed = false;
        throw error;
      });
    }
    return this.session;
  }

  private async performLogin(): Promise<void> {
    this.cookie = null;
    const res = await this.request("/api/v2/auth/login", {
      method: "POST",
      form: { username: this.username, password: this.password },
      retry: false,
    });
    const text = (await res.text()).trim();
    if (!res.ok || /^fails\.?$/i.test(text) || (text && !/^ok\.?$/i.test(text))) {
      this.cookie = null;
      throw new QbittorrentError("auth", "qBittorrent отклонил логин или пароль Web UI.");
    }
    this.authed = true;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    const text = await res.text();
    if (res.status === 403) {
      throw new QbittorrentError("auth", "qBittorrent отклонил сессию Web UI.");
    }
    if (res.status === 404) {
      throw new QbittorrentError("not_found", "qBittorrent не нашёл этот запрос.");
    }
    if (!res.ok) {
      throw new QbittorrentError("http", text.trim() || `qBittorrent ответил HTTP ${res.status}`);
    }
    const trimmed = text.trim();
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html") || trimmed.startsWith("<")) {
      throw new QbittorrentError(
        "api",
        "Ответ не похож на Web API qBittorrent. Нужен корень Web UI, например http://127.0.0.1:8080",
      );
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new QbittorrentError("api", "qBittorrent вернул не JSON.");
    }
  }

  private async form(path: string, fields: Record<string, string>): Promise<void> {
    const res = await this.request(path, { method: "POST", form: fields });
    await this.assertOk(res);
  }

  private async formPrefer(primary: string, fallback: string, fields: Record<string, string>): Promise<void> {
    const res = await this.request(primary, { method: "POST", form: fields });
    if (res.status === 404) {
      const second = await this.request(fallback, { method: "POST", form: fields });
      await this.assertOk(second);
      return;
    }
    await this.assertOk(res);
  }

  private async assertOk(res: Response): Promise<void> {
    const text = (await res.text()).trim();
    if (res.status === 403) {
      throw new QbittorrentError("auth", "qBittorrent отклонил сессию Web UI.");
    }
    if (/^fails\.?$/i.test(text)) {
      throw new QbittorrentError(
        "api",
        "qBittorrent отказал в операции. Проверьте путь и что раздача ещё есть.",
      );
    }
    if (!res.ok) {
      throw new QbittorrentError("http", text || `qBittorrent ответил HTTP ${res.status}`);
    }
  }

  private requireHashes(hashes: string[]): string[] {
    if (hashes.length === 0) throw new QbittorrentError("validation", "Не выбрана раздача.");
    return hashes.map((hash) => assertHash(hash));
  }

  private async request(
    path: string,
    init: { method?: string; form?: Record<string, string>; body?: BodyInit | null; retry?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("Referer", `${this.root}/`);
    headers.set("Origin", this.origin);
    if (this.cookie) headers.set("Cookie", this.cookie);
    let body = init.body ?? null;
    if (init.form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = new URLSearchParams(init.form).toString();
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.root}${path}`, {
        method: init.method ?? (body ? "POST" : "GET"),
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new QbittorrentError(
          "network",
          "Хост не ответил за 8 секунд. Проверьте IP, порт и что Web UI запущен.",
        );
      }
      throw new QbittorrentError("network", "Хост недоступен. Проверьте адрес и что Web UI включён.");
    }
    this.captureCookie(res);
    if (res.status === 403 && init.retry !== false && path !== "/api/v2/auth/login") {
      this.authed = false;
      this.cookie = null;
      this.session = null;
      await this.ready();
      return this.request(path, { ...init, retry: false });
    }
    return res;
  }

  private captureCookie(res: Response): void {
    const listed = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const cookies = listed.length > 0 ? listed : [res.headers.get("set-cookie") || ""];
    for (const cookie of cookies) {
      const pair = cookie.split(";")[0]?.trim();
      if (pair?.startsWith("SID=")) this.cookie = pair;
    }
  }
}
