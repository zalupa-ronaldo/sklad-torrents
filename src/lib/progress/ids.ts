export function torrentJobId(hostId: string, hash: string): string {
  return `torrent__${hostId}__${hash}`;
}

export function parseJobId(id: string): { kind: "torrent"; hostId: string; hash: string } | { kind: "local"; id: string } {
  const decoded = safeDecode(id);
  if (decoded.startsWith("torrent__")) {
    const rest = decoded.slice("torrent__".length);
    const split = rest.indexOf("__");
    if (split > 0) {
      return { kind: "torrent", hostId: rest.slice(0, split), hash: rest.slice(split + 2) };
    }
  }
  return { kind: "local", id: decoded };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
