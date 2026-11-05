import { QbittorrentError } from "@/lib/qbittorrent/errors";

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new QbittorrentError("validation", "Укажите адрес Web UI.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new QbittorrentError("validation", "Адрес должен быть как http://192.168.1.20:8080");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new QbittorrentError("validation", "Подходит только http или https, без прокси и посторонних схем.");
  }
  if (url.username || url.password) {
    throw new QbittorrentError("validation", "Логин и пароль пишите в отдельных полях, не в адресе.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/api(?:\/v2)?$/i, "");
  if (path === "/") path = "";
  return `${url.origin}${path}`;
}
