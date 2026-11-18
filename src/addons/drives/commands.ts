import type { HostOs, IndexCheckpoint, IndexStrategy } from "@/addons/drives/types";
import { isNtfs, selectIndexStrategy } from "@/addons/drives/strategy";
import { isIgnoredLetter, isVirtualAlcoholLetter, letterKey } from "@/addons/drives/volume-letters";
import { WINDOWS_VOLUME_EVENT_SCRIPT, WINDOWS_VOLUME_SCRIPT } from "@/addons/drives/win-script";

export const READ_ONLY_OPS = [
  "identify-volume",
  "stat-volume",
  "walk",
  "read-mft",
  "read-usn",
  "read-fsevents",
  "pause",
  "resume",
] as const;

export type ReadOnlyOp = (typeof READ_ONLY_OPS)[number];

export interface IndexCommand {
  op: ReadOnlyOp;
  reason: string;
}

export interface PlanInput {
  filesystem: string;
  platform: HostOs | "linux";
  elevated: boolean;
  busy: boolean;
  usnCheckpoint: boolean;
  cursor?: IndexCheckpoint;
  /** Set only after a catalog exists. Omitting it keeps the first-attach plan. */
  incremental?: "usn" | "fsevents";
}

const ALLOWED = new Set<string>(READ_ONLY_OPS);

const BANNED_TOKEN =
  /\b(format|mkfs|diskpart|chkdsk|compact|compress|erase|initialize|repair|delete|move|mountvol|assign|dismount)\b/i;

export function planIndexCommands(input: PlanInput): IndexCommand[] {
  if (input.busy) return [{ op: "pause", reason: "disk-busy" }];
  const decision = selectIndexStrategy(input);
  const commands: IndexCommand[] = [
    { op: "identify-volume", reason: "read-identity" },
    { op: "stat-volume", reason: "read-capacity" },
  ];
  if (input.incremental === "usn") {
    commands.push({ op: "read-usn", reason: "incremental-usn" });
  } else if (input.incremental === "fsevents") {
    commands.push({ op: "read-fsevents", reason: "fsevents-since" });
  } else if (isNtfs(input.filesystem) && input.platform === "win32") {
    commands.push({ op: "read-mft", reason: input.elevated ? "ntfs-mft" : "ntfs-mft-needs-admin" });
    if (input.elevated) commands.push({ op: "read-usn", reason: input.usnCheckpoint ? "incremental-usn" : "usn-checkpoint" });
  } else if (decision.strategy === "mft-usn") {
    commands.push({ op: "read-mft", reason: "ntfs-mft" });
    commands.push({ op: "read-usn", reason: input.usnCheckpoint ? "incremental-usn" : "usn-checkpoint" });
  } else {
    commands.push({ op: "walk", reason: "filesystem-walk" });
  }
  assertReadOnlyCommands(commands);
  return commands;
}

export function assertReadOnlyCommands(commands: readonly IndexCommand[]): void {
  for (const command of commands) {
    if (!ALLOWED.has(command.op)) {
      throw new Error(`Индексатор отклонил операцию ${command.op}.`);
    }
    if (BANNED_TOKEN.test(JSON.stringify(command))) {
      throw new Error(`Индексатор отклонил команду ${command.op}.`);
    }
  }
}

export interface SpawnRequest {
  bin: string;
  args: string[];
}

export function assertSpawnAllowed(request: SpawnRequest): void {
  const bin = request.bin;
  const args = request.args;
  const joined = [bin, ...args].join(" ");
  if (BANNED_TOKEN.test(joined)) {
    throw new Error("Индексатор отказался запускать эту команду.");
  }
  if (bin === "diskutil") {
    const target = args[1] ?? "";
    const one = args.length === 2 && args[0] === "info" && target.length > 0 && target !== "-all" && !target.startsWith("-") && !target.includes("..");
    if (!one) {
      throw new Error("Индексатор на macOS читает только diskutil info одного тома.");
    }
    return;
  }
  if (bin === "fsutil") {
    const letter = args[2] ?? "";
    const letterOk = /^[A-Za-z]:$/.test(letter);
    if (letterOk && (isIgnoredLetter(letterKey(letter)) || isVirtualAlcoholLetter(letterKey(letter)))) {
      throw new Error("Том исключён до открытия устройства.");
    }
    const query = args.length === 3 && args[0] === "usn" && args[1] === "queryJournal" && letterOk;
    const read =
      (args.length === 3 || args.length === 4) &&
      args[0] === "usn" &&
      args[1] === "readJournal" &&
      letterOk &&
      (args.length === 3 || /^\d+$/.test(args[3] ?? ""));
    if (!query && !read) {
      throw new Error("Индексатор на Windows читает только журнал USN.");
    }
    return;
  }
  if (bin === "powershell" || bin === "powershell.exe") {
    const scripts = [WINDOWS_VOLUME_SCRIPT, WINDOWS_VOLUME_EVENT_SCRIPT];
    const expected = scripts.map((script) => ["-NoProfile", "-NonInteractive", "-Command", script]);
    const allowed = expected.some((row) => args.length === row.length && args.every((arg, index) => arg === row[index]));
    if (!allowed) {
      throw new Error("Индексатор запускает только чтение сведений о томах.");
    }
    return;
  }
  throw new Error(`Индексатор не запускает ${bin}.`);
}

export function strategyOf(input: PlanInput): IndexStrategy {
  return selectIndexStrategy(input).strategy;
}
