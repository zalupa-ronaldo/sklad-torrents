import type { ContentKind, GameSubtype, IndexProfile, PostAction } from "@/lib/content/types";
import type { ClassifyReason } from "@/lib/content/types";
import type { CatalogDisk } from "@/lib/drives/types";
import type { HostOs } from "@/lib/qbittorrent/types";

export type QueueRole = "active" | "queued" | "waiting-offline" | "idle";

export type PresetId = "shelf" | "index-only" | "handbrake-cinema" | "custom";

export interface HandbrakeSettings {
  presetName: string;
  qualityMode: "rf" | "bitrate";
  quality: number;
  container: "mkv" | "mp4";
}

export interface TypeRule {
  diskId: string | null;
  customHostId: string;
  customPath: string;
  folder: string;
  indexProfile: IndexProfile;
  postAction: PostAction;
  handbrake: HandbrakeSettings;
}

export type PolicyRules = Record<ContentKind, TypeRule>;

export interface PolicyDocument {
  presetId: PresetId;
  automationEnabled: boolean;
  rules: PolicyRules;
  preview: { fingerprint: string; at: number } | null;
}

export interface ContentOverrideRecord {
  hostId: string;
  hash: string;
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
  updatedAt: number;
}

export interface PolicyHost {
  id: string;
  name: string;
  os: HostOs;
  online: boolean;
}

export interface PolicyTorrent {
  hostId: string;
  hostName: string;
  hash: string;
  name: string;
  savePath: string;
  progress: number;
  state: string;
  addedOn: number;
  files: { name: string; size: number }[];
}

export interface DryRunInput {
  torrents: PolicyTorrent[];
  hosts: PolicyHost[];
  disks: CatalogDisk[];
  rules: PolicyRules;
  overrides: ContentOverrideRecord[];
}

export type DryRunStep =
  | { type: "wait-offline"; diskLabel: string }
  | { type: "schedule"; role: "active" | "queued" }
  | { type: "setLocation"; via: "qbittorrent.setLocation"; location: string; deletesFiles: false }
  | { type: "hold-cross-host"; note: string }
  | { type: "index"; profile: IndexProfile }
  | { type: "queue-handbrake"; outputPath: string; presetName: string; deletesSource: false }
  | { type: "queue-compact"; outputPath: string; deletesSource: false };

export interface DryRunRow {
  hostId: string;
  hostName: string;
  hash: string;
  name: string;
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
  reason: ClassifyReason;
  detail: string;
  diskId: string | null;
  diskLabel: string;
  diskOnline: boolean;
  filesystem: string | null;
  folder: string;
  destinationPath: string;
  sameHost: boolean;
  indexProfile: IndexProfile;
  indexRequested: IndexProfile;
  indexNote: string | null;
  postAction: PostAction;
  postActionRequested: PostAction;
  postUnavailable: boolean;
  postNote: string | null;
  scheduler: QueueRole;
  deletesSource: false;
  steps: DryRunStep[];
}

export interface DryRunResult {
  rows: DryRunRow[];
  deletesSource: false;
}

export interface TorrentPlacement {
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
  reason: ClassifyReason;
  detail: string;
  diskLabel: string;
  diskOnline: boolean;
  folder: string;
  destinationPath: string;
  indexProfile: IndexProfile;
  postAction: PostAction;
  postActionRequested: PostAction;
  postUnavailable: boolean;
  postNote: string | null;
  indexNote: string | null;
  scheduler: QueueRole;
}
