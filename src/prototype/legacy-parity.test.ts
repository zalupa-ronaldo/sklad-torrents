import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api" || name === "node_modules") continue;
      walk(full, acc);
    } else if (/\.(tsx|ts|js)$/.test(name) && !name.includes(".test.")) acc.push(full);
  }
  return acc;
}

function pathsIn(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found = new Set<string>();
  const matches = text.match(/\/api\/(?:[A-Za-z0-9_./-]|\$\{[^}]+\})+/g) || [];
  for (const match of matches) {
    if (match.includes("localsend/v2")) continue;
    const normalized = match.replace(/\$\{[^}]+\}/g, ":id").replace(/\/+$/, "");
    found.add(normalized);
  }
  return [...found];
}

describe("legacy endpoint parity", () => {
  it("calls every panel endpoint the previous interface calls", () => {
    const legacy = ["src/components", "src/app", "src/addons"].flatMap((dir) => walk(path.join(root, dir)));
    const next = walk(path.join(root, "public/prototype")).filter((file) => file.endsWith(".js"));
    const legacyPaths = new Set(legacy.flatMap(pathsIn));
    const nextPaths = new Set(next.flatMap(pathsIn));
    const missing = [...legacyPaths].filter((item) => !nextPaths.has(item)).sort();
    expect(missing).toEqual([]);
    for (const required of [
      "/api/torrents/transfers",
      "/api/torrents/transfers/control",
      "/api/torrents/transfers/policy",
      "/api/torrents/supervisor",
      "/api/tools/av1-status",
    ]) {
      expect(nextPaths.has(required)).toBe(true);
    }
  });
});
