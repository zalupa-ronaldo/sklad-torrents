import type { CollectedVolume } from "@/addons/drives/types";

interface DiskutilRecord {
  id: string;
  fields: Map<string, string>;
}

function recordsFrom(text: string): DiskutilRecord[] {
  const lines = text.split(/\r?\n/);
  const records: DiskutilRecord[] = [];
  let current: DiskutilRecord | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "Device Identifier") {
      current = { id: value, fields: new Map([[key, value]]) };
      records.push(current);
      continue;
    }
    current?.fields.set(key, value);
  }
  return records;
}

function bytesFrom(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/\((\d+)\s+Bytes\)/i);
  if (!match) return 0;
  const size = Number(match[1]);
  return Number.isFinite(size) ? size : 0;
}

function field(record: DiskutilRecord, key: string): string {
  return record.fields.get(key)?.trim() ?? "";
}

function walkSerial(id: string, byId: ReadonlyMap<string, DiskutilRecord>, guard = new Set<string>()): string {
  if (guard.has(id)) return "";
  guard.add(id);
  const record = byId.get(id);
  if (!record) return "";
  const serial = field(record, "Device / Media Serial Number") || field(record, "Serial Number");
  if (serial && serial !== "Unknown") return serial;
  const parent = field(record, "Part of Whole");
  if (!parent || parent === id) return "";
  return walkSerial(parent, byId, guard);
}

export function parseDiskutil(text: string): CollectedVolume[] {
  const records = recordsFrom(text);
  const byId = new Map(records.map((record) => [record.id, record]));
  const volumes: CollectedVolume[] = [];
  for (const record of records) {
    const uuid = field(record, "Volume UUID");
    const personality = field(record, "File System Personality") || field(record, "Type (Bundle)");
    const mount = field(record, "Mount Point");
    const mounted = Boolean(mount) && mount !== "Not applicable";
    const name = field(record, "Volume Name");
    if (!uuid || (!mounted && !name)) continue;
    if (field(record, "Whole") === "Yes" && !mounted) continue;
    const serial = walkSerial(record.id, byId);
    volumes.push({
      serial,
      volumeUuid: uuid,
      filesystem: personality || "unknown",
      volumeName: name,
      mountPaths: mounted ? [mount] : [],
      totalBytes: bytesFrom(field(record, "Disk Size")) || bytesFrom(field(record, "Volume Total Space")),
      freeBytes: bytesFrom(field(record, "Volume Free Space")) || bytesFrom(field(record, "Container Free Space")),
      busy: false,
      letter: null,
    });
  }
  return volumes;
}
