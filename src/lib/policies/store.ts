import { CONTENT_KINDS, isContentKind, isGameSubtype } from "@/lib/content/types";
import type { ContentKind, GameSubtype, IndexProfile, PostAction } from "@/lib/content/types";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { dataFile, readJsonFile, writeJsonFile } from "@/lib/json-file";
import { PRESETS, emptyRules } from "@/lib/policies/presets";
import type { ContentOverrideRecord, HandbrakeSettings, PolicyDocument, PolicyRules, PresetId, TypeRule } from "@/lib/policies/types";
import { replaceRules } from "@/lib/policies/dry-run";

interface PolicyFile {
  policy?: unknown;
}

interface OverrideFile {
  overrides?: unknown;
}

export async function loadPolicy(): Promise<PolicyDocument> {
  const file = await readJsonFile<PolicyFile>(dataFile("content-policies.json"), {});
  return normalizePolicy(file.policy) ?? defaultPolicy();
}

export async function savePolicy(policy: PolicyDocument): Promise<void> {
  await writeJsonFile(dataFile("content-policies.json"), { policy });
}

export function defaultPolicy(): PolicyDocument {
  return {
    presetId: "shelf",
    automationEnabled: true,
    rules: emptyRules(),
    preview: null,
  };
}

export async function loadOverrides(): Promise<ContentOverrideRecord[]> {
  const file = await readJsonFile<OverrideFile>(dataFile("content-overrides.json"), {});
  if (!Array.isArray(file.overrides)) return [];
  return file.overrides.filter(isOverride);
}

export async function saveOverride(record: ContentOverrideRecord): Promise<ContentOverrideRecord[]> {
  const overrides = (await loadOverrides()).filter((item) => !(item.hostId === record.hostId && item.hash === record.hash));
  overrides.push(record);
  await writeJsonFile(dataFile("content-overrides.json"), { overrides });
  return overrides;
}

export async function clearOverride(hostId: string, hash: string): Promise<void> {
  const overrides = (await loadOverrides()).filter((item) => !(item.hostId === hostId && item.hash === hash));
  await writeJsonFile(dataFile("content-overrides.json"), { overrides });
}

export function applyNamedPreset(policy: PolicyDocument, presetId: Exclude<PresetId, "custom">): PolicyDocument {
  const preset = PRESETS[presetId];
  if (!preset) throw new QbittorrentError("validation", "Неизвестный пресет.");
  const next = replaceRules(policy, structuredClone(preset.rules), presetId);
  // Named presets never arm automation by themselves.
  return { ...next, automationEnabled: false, preview: null };
}

export function saveCustomRules(policy: PolicyDocument, rules: unknown): PolicyDocument {
  return replaceRules(policy, sanitizeRules(rules, policy.rules), "custom");
}

export function sanitizeRules(input: unknown, fallback: PolicyRules): PolicyRules {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rules = {} as PolicyRules;
  for (const kind of CONTENT_KINDS) {
    rules[kind] = sanitizeRule(source[kind], fallback[kind]);
  }
  return rules;
}

function sanitizeRule(input: unknown, fallback: TypeRule): TypeRule {
  const raw = input && typeof input === "object" ? (input as Partial<TypeRule>) : {};
  const diskId = typeof raw.diskId === "string" && raw.diskId.trim() ? raw.diskId.trim() : null;
  return {
    diskId,
    customHostId: typeof raw.customHostId === "string" ? raw.customHostId.trim().slice(0, 80) : "",
    customPath: typeof raw.customPath === "string" ? raw.customPath.trim().slice(0, 400) : "",
    folder: cleanFolder(raw.folder, fallback.folder),
    indexProfile: cleanIndex(raw.indexProfile, fallback.indexProfile),
    postAction: cleanPost(raw.postAction, fallback.postAction),
    handbrake: cleanHandbrake(raw.handbrake, fallback.handbrake),
  };
}

function cleanFolder(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim().replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (!raw) return "";
  if (raw.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new QbittorrentError("validation", "Папка назначения не может содержать ..");
  }
  return raw.slice(0, 180);
}

function cleanIndex(value: unknown, fallback: IndexProfile): IndexProfile {
  if (value === "none" || value === "walk" || value === "ntfs-mft") return value;
  return fallback;
}

function cleanPost(value: unknown, fallback: PostAction): PostAction {
  if (value === "none" || value === "compact" || value === "handbrake") return value;
  return fallback;
}

function cleanHandbrake(value: unknown, fallback: HandbrakeSettings): HandbrakeSettings {
  const raw = value && typeof value === "object" ? (value as Partial<HandbrakeSettings>) : {};
  const qualityMode = raw.qualityMode === "bitrate" ? "bitrate" : raw.qualityMode === "rf" ? "rf" : fallback.qualityMode;
  let quality = Number(raw.quality);
  if (!Number.isFinite(quality)) quality = fallback.quality;
  quality = qualityMode === "rf" ? clamp(Math.round(quality), 0, 51) : clamp(Math.round(quality), 100, 50000);
  const container = raw.container === "mp4" ? "mp4" : raw.container === "mkv" ? "mkv" : fallback.container;
  const presetName = typeof raw.presetName === "string" ? raw.presetName.trim().slice(0, 80) : "";
  return {
    presetName: presetName || fallback.presetName,
    qualityMode,
    quality,
    container,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePolicy(value: unknown): PolicyDocument | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PolicyDocument>;
  const presetId = isPreset(raw.presetId) ? raw.presetId : "custom";
  const base = defaultPolicy();
  try {
    return {
      presetId,
      automationEnabled: raw.automationEnabled !== false,
      rules: sanitizeRules(raw.rules, base.rules),
      preview: normalizePreview(raw.preview),
    };
  } catch {
    return null;
  }
}

function normalizePreview(value: unknown): PolicyDocument["preview"] {
  if (!value || typeof value !== "object") return null;
  const preview = value as { fingerprint?: unknown; at?: unknown };
  if (typeof preview.fingerprint !== "string" || !preview.fingerprint) return null;
  return { fingerprint: preview.fingerprint, at: typeof preview.at === "number" ? preview.at : Date.now() };
}

function isPreset(value: unknown): value is PresetId {
  return value === "shelf" || value === "index-only" || value === "handbrake-cinema" || value === "custom";
}

function isOverride(value: unknown): value is ContentOverrideRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ContentOverrideRecord>;
  if (typeof record.hostId !== "string" || typeof record.hash !== "string" || !isContentKind(record.kind)) return false;
  const gameSubtype = record.kind === "game" ? (isGameSubtype(record.gameSubtype) ? record.gameSubtype : "other") : null;
  record.gameSubtype = gameSubtype;
  return true;
}

export function overrideRecord(hostId: string, hash: string, kind: ContentKind, gameSubtype: GameSubtype | null): ContentOverrideRecord {
  return {
    hostId,
    hash,
    kind,
    gameSubtype: kind === "game" ? (gameSubtype ?? "other") : null,
    updatedAt: Date.now(),
  };
}
