export type QueueRole = "active" | "queued" | "waiting-offline" | "idle";

export interface DiskQueueItem {
  id: string;
  diskId: string;
  /** Incomplete torrent that still needs the disk. */
  wantsDownload: boolean;
  /** Already transferring, so it keeps the single active slot when possible. */
  downloading: boolean;
  /** Current save path is already on this physical disk. */
  onDisk: boolean;
  addedOn: number;
}

export interface QueueDisk {
  id: string;
  online: boolean;
}

/**
 * One active download per physical disk.
 * The content policy chooses the disk. This only decides who may download.
 * An offline disk never receives an active download.
 */
export function planOneActivePerDisk(items: DiskQueueItem[], disks: QueueDisk[]): Map<string, QueueRole> {
  const online = new Map(disks.map((disk) => [disk.id, disk.online]));
  const plan = new Map<string, QueueRole>();
  const waiting = new Map<string, DiskQueueItem[]>();

  for (const item of items) {
    if (!item.wantsDownload) {
      plan.set(item.id, "idle");
      continue;
    }
    const group = waiting.get(item.diskId) ?? [];
    group.push(item);
    waiting.set(item.diskId, group);
  }

  for (const [diskId, group] of waiting) {
    if (online.get(diskId) !== true) {
      for (const item of group) plan.set(item.id, "waiting-offline");
      continue;
    }
    const ordered = [...group].sort(compareQueue);
    ordered.forEach((item, index) => {
      plan.set(item.id, index === 0 ? "active" : "queued");
    });
  }

  return plan;
}

export function activeCount(plan: Map<string, QueueRole>, items: DiskQueueItem[], diskId?: string): number {
  return items.filter((item) => {
    if (diskId && item.diskId !== diskId) return false;
    return plan.get(item.id) === "active";
  }).length;
}

function compareQueue(a: DiskQueueItem, b: DiskQueueItem): number {
  const rank = (item: DiskQueueItem) => {
    if (item.onDisk && item.downloading) return 0;
    if (item.downloading) return 1;
    return 2;
  };
  return rank(a) - rank(b) || a.addedOn - b.addedOn || a.id.localeCompare(b.id);
}
