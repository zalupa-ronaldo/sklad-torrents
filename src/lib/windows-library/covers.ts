import type { CoverCacheEntry, CoverRef } from "@/lib/windows-library/types";

/** Public Steam CDN capsule. No API key. The list call does not download it. */
export function steamCoverUrl(appId: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

export function coverCacheKey(input: { title: string; steamAppId: number | null }): { steam: string | null; name: string; steamGridDb: string } {
  const name = normalizeTitle(input.title);
  return {
    steam: input.steamAppId == null ? null : `steam:${input.steamAppId}`,
    name: `name:${name}`,
    steamGridDb: `steamgriddb:${name}`,
  };
}

/**
 * Resolve a cover from the local cache, then a Steam AppID, then the title.
 * SteamGridDB is only a cache key. Nothing is fetched.
 */
export function coverFor(
  input: { title: string; steamAppId: number | null },
  cache: Readonly<Record<string, CoverCacheEntry>>,
): CoverRef {
  const keys = coverCacheKey(input);
  const steamHit = keys.steam ? cache[keys.steam] : undefined;
  if (steamHit) return { cacheKey: keys.steam!, source: "cache", url: steamHit.url, cached: true };
  const nameHit = cache[keys.name];
  if (nameHit) return { cacheKey: keys.name, source: "cache", url: nameHit.url, cached: true };
  const gridHit = cache[keys.steamGridDb];
  if (gridHit) return { cacheKey: keys.steamGridDb, source: "steamgriddb", url: gridHit.url, cached: true };
  if (input.steamAppId != null && keys.steam) {
    return { cacheKey: keys.steam, source: "steam-app", url: steamCoverUrl(input.steamAppId), cached: false };
  }
  return { cacheKey: keys.name, source: "name", url: null, cached: false };
}

export function normalizeTitle(title: string): string {
  return title.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}
