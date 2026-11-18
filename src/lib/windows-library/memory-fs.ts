import { createHash } from "node:crypto";

/** In-memory files for the move worker. Tests never point this at a real disk. */
export class MemoryFs {
  private readonly files = new Map<string, Buffer>();

  writeText(file: string, text: string): void {
    this.writeBytes(file, Buffer.from(text));
  }

  readText(file: string): string | null {
    const bytes = this.readBytes(file);
    return bytes ? bytes.toString("utf8") : null;
  }

  writeBytes(file: string, data: Buffer): void {
    this.files.set(keyOf(file), Buffer.from(data));
  }

  readBytes(file: string): Buffer | null {
    const found = this.files.get(keyOf(file));
    return found ? Buffer.from(found) : null;
  }

  listFiles(root: string): { full: string; rel: string }[] {
    const base = keyOf(root);
    const out: { full: string; rel: string }[] = [];
    for (const file of this.files.keys()) {
      if (file === base || !file.startsWith(`${base}/`)) continue;
      out.push({ full: file, rel: file.slice(base.length + 1) });
    }
    return out;
  }

  remove(path: string): void {
    const base = keyOf(path);
    for (const file of [...this.files.keys()]) {
      if (file === base || file.startsWith(`${base}/`)) this.files.delete(file);
    }
  }

  exists(path: string): boolean {
    const base = keyOf(path);
    if (this.files.has(base)) return true;
    for (const file of this.files.keys()) {
      if (file.startsWith(`${base}/`)) return true;
    }
    return false;
  }
}

export function treeHash(fs: MemoryFs, root: string): string {
  const hash = createHash("sha256");
  const files = fs.listFiles(root).filter((file) => file.rel !== ".sklad-winlib" && !file.rel.endsWith("/.sklad-winlib"));
  files.sort((left, right) => left.rel.localeCompare(right.rel));
  for (const file of files) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(fs.readBytes(file.full) ?? Buffer.alloc(0));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function keyOf(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}
