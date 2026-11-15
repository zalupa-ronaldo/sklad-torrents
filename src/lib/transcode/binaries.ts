import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export async function resolveTool(input: { envName: string; names: readonly string[] }): Promise<{ path: string | null; source: "env" | "path" | "missing" }> {
  const explicit = process.env[input.envName]?.trim();
  if (explicit) {
    const found = await executable(explicit);
    return found ? { path: found, source: "env" } : { path: null, source: "missing" };
  }
  for (const name of input.names) {
    const found = await lookup(name);
    if (found) return { path: found, source: "path" };
  }
  return { path: null, source: "missing" };
}

export function missingToolError(envName: string, tool: string): string {
  return `${tool} не найден. Задайте ${envName} или флаг CLI абсолютным путём к доверенной сборке. Эта система не объявляется неподдерживаемой. Код выхода HandBrake проверку не заменяет.`;
}

async function lookup(name: string): Promise<string | null> {
  const names = process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? [name, `${name}.exe`] : [name];
  for (const candidate of names) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const found = await executable(path.join(dir, candidate));
      if (found) return found;
    }
  }
  return null;
}

async function executable(file: string): Promise<string | null> {
  try {
    await access(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}
