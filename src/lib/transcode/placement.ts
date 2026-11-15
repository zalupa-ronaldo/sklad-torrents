/**
 * Shared HandBrake queue. Each machine takes a different next file.
 * A file that already lives on that machine is not sent across the network.
 * Anything else is a copy checked with SHA-256. The source is not deleted here.
 */

export type MachineRole = "pc" | "mac";
export type FileHome = MachineRole | "shared";
export type EncodeTransport = "local" | "copy";

export function fileHome(source: string): FileHome {
  const text = source.trim();
  if (/^(?:\\\\\?\\)?[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("//")) return "pc";
  if (/^\/mnt\/[a-zA-Z]\//.test(text)) return "pc";
  if (text.startsWith("/Volumes/") || text.startsWith("/Users/")) return "mac";
  return "shared";
}

export interface PeerSeat {
  role: MachineRole;
  /** Slots that can still start a file. Zero, pause, or busy means this machine will not take it. */
  freeSlots: number;
  paused?: boolean;
  userBusy?: boolean;
}

export function homeHasSeat(home: FileHome, peers: readonly PeerSeat[]): boolean {
  if (home === "shared") return false;
  return peers.some((peer) => peer.role === home && peer.freeSlots > 0 && peer.paused !== true && peer.userBusy !== true);
}

export function workerMayTake(input: {
  source: string;
  workerRole: MachineRole;
  peers: readonly PeerSeat[];
}): { take: boolean; transport: EncodeTransport; reason: string } {
  const home = fileHome(input.source);
  if (home === "shared") {
    return { take: true, transport: "copy", reason: "Файл не привязан к диску Mac или ПК. Между машинами уходит копия, каждый кусок сверяется SHA-256." };
  }
  if (home === input.workerRole) {
    return { take: true, transport: "local", reason: "Файл уже на этой машине. По сети он не отправляется." };
  }
  if (homeHasSeat(home, input.peers)) {
    return { take: false, transport: "copy", reason: "Файл лежит на другой машине, и у неё есть свободный слот. Этот воркер его не скачивает." };
  }
  return { take: true, transport: "copy", reason: "На машине файла нет свободного слота. Уходит копия с SHA-256, исходник не удаляется." };
}

/** Prefer a file that already lives here, even if a newer file belongs on the other machine. */
export function chooseQueuedFile<T extends { source: string }>(input: {
  jobs: readonly T[];
  workerRole: MachineRole;
  peers: readonly PeerSeat[];
}): { job: T; transport: EncodeTransport } | null {
  const ranked = input.jobs.map((job) => ({ job, place: workerMayTake({ source: job.source, workerRole: input.workerRole, peers: input.peers }) }));
  const local = ranked.find((item) => item.place.take && item.place.transport === "local");
  if (local) return { job: local.job, transport: "local" };
  const copy = ranked.find((item) => item.place.take && item.place.transport === "copy");
  return copy ? { job: copy.job, transport: "copy" } : null;
}
