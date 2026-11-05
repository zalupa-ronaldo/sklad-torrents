import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = pathToFileURL(path.join(srcRoot, `${specifier.slice(2)}.ts`)).href;
    return nextResolve(target, context);
  }
  return nextResolve(specifier, context);
}
