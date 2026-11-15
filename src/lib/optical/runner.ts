import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { OpticalError } from "@/lib/optical/errors";

export interface CommandRequest {
  argv: string[];
  phase: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  mock: boolean;
}

export interface ProcessRunner {
  readonly mock: boolean;
  run(request: CommandRequest): Promise<CommandResult>;
}

export type CommandSpawn = (argv: string[]) => Promise<CommandResult>;

const KNOWN: Record<string, string[]> = {
  hdiutil: ["/usr/bin/hdiutil"],
  drutil: ["/usr/bin/drutil"],
  diskutil: ["/usr/sbin/diskutil"],
  "powershell.exe": ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  powershell: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  wmic: ["C:\\Windows\\System32\\wbem\\WMIC.exe"],
};

export async function lookupBinary(name: string): Promise<string | null> {
  const base = name.replace(/\.exe$/i, "");
  const knownList = (key: string): string[] => (Object.hasOwn(KNOWN, key) ? KNOWN[key] ?? [] : []);
  const candidates = [...knownList(name), ...knownList(base)];
  for (const candidate of candidates) {
    if (await canExecute(candidate)) return candidate;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const bin of [name, base, `${base}.exe`]) {
      const full = path.join(dir, bin);
      if (await canExecute(full)) return full;
    }
  }
  return null;
}

async function canExecute(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createToolRunner(lookup: (name: string) => Promise<string | null> = lookupBinary): ProcessRunner {
  return {
    mock: false,
    async run(request) {
      const bin = request.argv[0];
      const resolved = await lookup(bin);
      if (!resolved) throw new OpticalError("tool_not_found", `Утилита не найдена: ${bin}`);
      return spawnCommand(resolved, request.argv.slice(1));
    },
  };
}

export function createMockRunner(options?: {
  hold?: Promise<void>;
  verifyCode?: number;
  delayMs?: number;
}): ProcessRunner & { calls: CommandRequest[] } {
  const calls: CommandRequest[] = [];
  const delayMs = options?.delayMs ?? 0;
  return {
    mock: true,
    calls,
    async run(request) {
      calls.push({ argv: [...request.argv], phase: request.phase });
      if (options?.hold) await options.hold;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (request.phase === "проверка" && (options?.verifyCode ?? 0) !== 0) {
        return { code: options?.verifyCode ?? 1, stdout: "", stderr: "verify failed", mock: true };
      }
      return { code: 0, stdout: "mock", stderr: "", mock: true };
    },
  };
}

function spawnCommand(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new OpticalError("tool_not_found", `Утилита не найдена: ${bin}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr, mock: false });
    });
  });
}
