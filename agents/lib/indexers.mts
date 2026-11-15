import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

import { assertSpawnAllowed } from "../../src/addons/drives/commands.ts";
import { assertLetterAllowed } from "../../src/addons/drives/volume-guard.ts";
import { readNtfsVolume } from "../../src/addons/drives/ntfs-mft.ts";
import { parseFsutilUsn } from "../../src/addons/drives/usn.ts";
import type { IndexDelta } from "../../src/addons/drives/types.ts";

const exec = promisify(execFile);

export async function readNtfsLetter(letter: string): Promise<{ files: Awaited<ReturnType<typeof readNtfsVolume>>["files"]; complete: boolean }> {
  assertLetterAllowed(letter);
  const handle = await open(`\\\\.\\${letter}:`, "r");
  try {
    return await readNtfsVolume(async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error("Короткое чтение тома.");
      return buffer;
    });
  } finally {
    await handle.close();
  }
}

export async function readUsn(letter: string, start: string | null): Promise<{ delta: IndexDelta | null; nextUsn: string | null }> {
  assertLetterAllowed(letter);
  const query = { bin: "fsutil", args: ["usn", "queryJournal", `${letter}:`] };
  assertSpawnAllowed(query);
  const queried = await exec(query.bin, query.args, { timeout: 15_000, windowsHide: true, maxBuffer: 1_000_000 });
  const nextMatch = queried.stdout.match(/Next Usn\s*:\s*(\d+)/i);
  const nextUsn = nextMatch?.[1] ?? null;
  if (!start || !/^\d+$/.test(start)) return { delta: null, nextUsn };
  const read = { bin: "fsutil", args: ["usn", "readJournal", `${letter}:`, start] };
  assertSpawnAllowed(read);
  const journal = await exec(read.bin, read.args, { timeout: 20_000, windowsHide: true, maxBuffer: 8_000_000 });
  const truncated = journal.stdout.length >= 7_900_000;
  return { delta: parseFsutilUsn(journal.stdout, { truncated }), nextUsn };
}
