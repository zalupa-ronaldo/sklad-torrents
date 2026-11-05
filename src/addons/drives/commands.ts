import type { HostOs, IndexStrategy } from "@/addons/drives/types";
import { selectIndexStrategy } from "@/addons/drives/strategy";
import { WINDOWS_VOLUME_SCRIPT } from "@/addons/drives/win-script";

export const READ_ONLY_OPS = [
  "identify-volume",
  "stat-volume",
  "walk",
  "read-mft",
  "read-usn",
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
  if (decision.strategy === "mft-usn") {
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
    if (args.length !== 2 || args[0] !== "info" || args[1] !== "-all") {
      throw new Error("Индексатор на macOS читает только diskutil info -all.");
    }
    return;
  }
  if (bin === "fsutil") {
    const letter = args[2] ?? "";
    const letterOk = /^[A-Za-z]:$/.test(letter);
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
    const expected = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOLUME_SCRIPT];
    if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) {
      throw new Error("Индексатор запускает только чтение сведений о томах.");
    }
    return;
  }
  throw new Error(`Индексатор не запускает ${bin}.`);
}

export function strategyOf(input: PlanInput): IndexStrategy {
  return selectIndexStrategy(input).strategy;
}
