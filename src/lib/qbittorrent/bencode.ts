function indexOfByte(buffer: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < buffer.length; i += 1) {
    if (buffer[i] === byte) return i;
  }
  return -1;
}

export function decodeBencode(buffer: Uint8Array, offset = 0, depth = 0): { value: unknown; offset: number } {
  if (depth > 32) throw new Error("bencode too deep");
  if (offset >= buffer.length) throw new Error("bencode truncated");
  const marker = buffer[offset];
  if (marker === 0x69) {
    const end = indexOfByte(buffer, 0x65, offset + 1);
    if (end < 0) throw new Error("bencode int");
    const text = new TextDecoder().decode(buffer.subarray(offset + 1, end));
    return { value: Number(text), offset: end + 1 };
  }
  if (marker === 0x6c) {
    const list: unknown[] = [];
    let cursor = offset + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const next = decodeBencode(buffer, cursor, depth + 1);
      list.push(next.value);
      cursor = next.offset;
    }
    if (buffer[cursor] !== 0x65) throw new Error("bencode list truncated");
    return { value: list, offset: cursor + 1 };
  }
  if (marker === 0x64) {
    const dict: Record<string, unknown> = {};
    let cursor = offset + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      const key = decodeBencode(buffer, cursor, depth + 1);
      const val = decodeBencode(buffer, key.offset, depth + 1);
      dict[String(key.value)] = val.value;
      cursor = val.offset;
    }
    if (buffer[cursor] !== 0x65) throw new Error("bencode dict truncated");
    return { value: dict, offset: cursor + 1 };
  }
  const colon = indexOfByte(buffer, 0x3a, offset);
  if (colon < 0) throw new Error("bencode string");
  const length = Number(new TextDecoder().decode(buffer.subarray(offset, colon)));
  if (!Number.isInteger(length) || length < 0) throw new Error("bencode length");
  const start = colon + 1;
  const end = start + length;
  if (end > buffer.length) throw new Error("bencode string truncated");
  return { value: new TextDecoder().decode(buffer.subarray(start, end)), offset: end };
}

export function torrentDisplayName(data: Uint8Array, fallback: string): string {
  try {
    const decoded = decodeBencode(data).value as { info?: { name?: unknown } } | null;
    const name = decoded && typeof decoded === "object" ? decoded.info?.name : undefined;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // A broken .torrent still gets a name from the file name.
  }
  return fallback.replace(/\.torrent$/i, "") || "Без имени";
}
