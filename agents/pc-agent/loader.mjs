import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".cjs"];
const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/**
 * Resolve extensionless relative imports and the `@/` alias to files on disk.
 * Node's type stripper executes the resolved `.ts` file.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const abs = path.join(srcRoot, specifier.slice(2));
    return resolveFile(abs, context, nextResolve);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(process.cwd(), "noop.js");
    const abs = path.resolve(path.dirname(parent), specifier);
    if (path.extname(abs)) return nextResolve(specifier, context);
    return resolveFile(abs, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

async function resolveFile(abs, context, nextResolve) {
  if (existsSync(abs) && !abs.endsWith(path.sep)) {
    return nextResolve(pathToFileURL(abs).href, context);
  }
  for (const ext of EXTENSIONS) {
    if (existsSync(abs + ext)) {
      return nextResolve(pathToFileURL(abs + ext).href, context);
    }
  }
  for (const ext of EXTENSIONS) {
    const index = path.join(abs, `index${ext}`);
    if (existsSync(index)) return nextResolve(pathToFileURL(index).href, context);
  }
  return nextResolve(pathToFileURL(abs).href, context);
}
