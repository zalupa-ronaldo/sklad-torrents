import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Raw NTFS reader. DeviceIoControl runs inside usn.ps1 on Windows only.
 * Vitest must not import this module: the throw below fires before any volume is opened.
 * APFS and /Volumes are rejected here as well as in chooseIndexStrategy.
 */
if (process.env.VITEST) {
  throw new Error("Модуль agents/pc-agent/win32/ntfs.ts не запускается в тестах и не открывает том.");
}

const scriptPath = fileURLToPath(new URL("./usn.ps1", import.meta.url));

export async function isWindowsElevated(): Promise<boolean> {
  assertWindows();
  const output = await runPowershell("elevated", "C", 0n);
  return output.trim() === "yes";
}

/** FSCTL_ENUM_USN_DATA: a full listing of MFT file records as USN_RECORD_V2 bytes. */
export async function enumerateMft(volume: string): Promise<{ records: Buffer }> {
  assertWindows();
  const letter = driveLetter(volume);
  const output = await runPowershell("enumerate", letter, 0n);
  return { records: decodeRecords(output) };
}

/** FSCTL_READ_USN_JOURNAL from `startUsn`. The 8-byte next-USN header is stripped in the script. */
export async function readUsnJournal(volume: string, startUsn: bigint): Promise<{ records: Buffer }> {
  assertWindows();
  const letter = driveLetter(volume);
  const output = await runPowershell("journal", letter, startUsn);
  return { records: decodeRecords(output) };
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Чтение MFT и журнала USN доступно только в Windows.");
  }
}

function driveLetter(volume: string): string {
  if (volume.includes("/Volumes") || volume.trim().startsWith("/")) {
    throw new Error("MFT и USN не запускаются для APFS и путей /Volumes.");
  }
  const match = volume.trim().match(/^(?:\\\\\.[\\/])?([A-Za-z]):\\?$/);
  if (!match?.[1]) throw new Error("Ожидалась буква тома NTFS, например D:.");
  return match[1].toUpperCase();
}

function decodeRecords(output: string): Buffer {
  const text = output.trim();
  if (!text) return Buffer.alloc(0);
  return Buffer.from(text, "base64");
}

function runPowershell(mode: "elevated" | "enumerate" | "journal", letter: string, startUsn: bigint): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        windowsHide: true,
        env: {
          ...process.env,
          SKLAD_VOLUME: letter,
          SKLAD_MODE: mode,
          SKLAD_START_USN: startUsn.toString(),
        },
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim() || `powershell ${code}`;
        reject(new Error(detail));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
