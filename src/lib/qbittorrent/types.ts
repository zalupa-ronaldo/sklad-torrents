export type HostOs = "darwin" | "win32";
export type HostKind = "mock" | "http";

export type NormalizedState =
  | "downloading"
  | "metadata"
  | "stalled"
  | "paused"
  | "queued"
  | "seeding"
  | "checking"
  | "moving"
  | "error"
  | "missing"
  | "unknown";

export interface PathPreset {
  id: string;
  label: string;
  path: string;
}

export interface HostRecord {
  id: string;
  name: string;
  kind: HostKind;
  baseUrl: string;
  username: string;
  password: string;
  os: HostOs;
  pathPresets: PathPreset[];
}

export interface HostPublic {
  id: string;
  name: string;
  kind: HostKind;
  baseUrl: string;
  username: string;
  os: HostOs;
  pathPresets: PathPreset[];
  hasPassword: boolean;
}

export interface HostView extends HostPublic {
  online: boolean;
  error: string | null;
  appVersion: string | null;
  webapiVersion: string | null;
  torrentCount: number;
}

export interface MoveMark {
  hostId: string;
  hash: string;
  destination: string;
  markedAt: number;
}

export interface TorrentSnapshot {
  hash: string;
  name: string;
  state: NormalizedState;
  rawState: string;
  progress: number;
  size: number;
  totalSize: number;
  downloaded: number;
  uploaded: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  ratio: number;
  savePath: string;
  contentPath: string;
  addedOn: number;
  completionOn: number;
  numSeeds: number;
  numLeechs: number;
  category: string;
  tags: string[];
}

export interface TorrentView extends TorrentSnapshot {
  hostId: string;
  hostName: string;
  hostOs: HostOs;
  moveMark: MoveMark | null;
}

export interface TorrentFileSnapshot {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface TorrentFileView extends TorrentFileSnapshot {
  absolutePath: string;
}

export interface QbProbe {
  appVersion: string;
  webapiVersion: string;
  defaultSavePath: string;
}

export interface AddTorrentInput {
  urls?: string;
  torrent?: { filename: string; data: Uint8Array };
  savePath?: string;
  paused?: boolean;
}

export interface DashboardPayload {
  hosts: HostView[];
  torrents: TorrentView[];
}

export interface TorrentDetailPayload {
  torrent: TorrentView;
  files: TorrentFileView[];
}

export interface RawTorrent {
  hash?: string;
  name?: string;
  state?: string;
  progress?: number;
  size?: number;
  total_size?: number;
  downloaded?: number;
  uploaded?: number;
  dlspeed?: number;
  upspeed?: number;
  eta?: number;
  ratio?: number;
  save_path?: string;
  content_path?: string;
  added_on?: number;
  completion_on?: number;
  num_seeds?: number;
  num_leechs?: number;
  category?: string;
  tags?: string;
}

export interface RawFile {
  index?: number;
  name?: string;
  size?: number;
  progress?: number;
  priority?: number;
}
