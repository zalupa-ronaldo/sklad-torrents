export interface SteamLibrary {
  path: string;
  apps: { id: string; size: string }[];
}

type Vdf = { kind: "str"; value: string } | { kind: "obj"; entries: { key: string; value: Vdf }[] };

/** Move one Steam app between library folders inside libraryfolders.vdf. */
export function moveSteamApp(text: string, fromLibrary: string, toLibrary: string, appId: string, sizeBytes: number): string {
  const root = parseVdf(text);
  if (root.kind !== "obj") throw new Error("libraryfolders.vdf не разобран.");
  const table = root.entries.find((entry) => entry.key.toLowerCase() === "libraryfolders");
  if (!table || table.value.kind !== "obj") throw new Error("В libraryfolders.vdf нет таблицы библиотек.");
  const source = libraryEntry(table.value, fromLibrary);
  if (source) {
    const apps = child(source, "apps");
    if (apps?.kind === "obj") apps.entries = apps.entries.filter((entry) => entry.key !== appId);
  }
  let dest = libraryEntry(table.value, toLibrary);
  if (!dest) {
    dest = { kind: "obj", entries: [{ key: "path", value: { kind: "str", value: toLibrary } }, { key: "apps", value: { kind: "obj", entries: [] } }] };
    const index = String(table.value.entries.length);
    table.value.entries.push({ key: index, value: dest });
  }
  let apps = child(dest, "apps");
  if (!apps || apps.kind !== "obj") {
    apps = { kind: "obj", entries: [] };
    dest.entries.push({ key: "apps", value: apps });
  }
  apps.entries = apps.entries.filter((entry) => entry.key !== appId);
  apps.entries.push({ key: appId, value: { kind: "str", value: String(sizeBytes) } });
  return stringifyDocument(root);
}

/** Keep StateFlags installed and do not ask Steam to validate or download again. */
export function retargetAppManifest(text: string, logicalBytes: number): string {
  const root = parseVdf(text);
  if (root.kind !== "obj") throw new Error("appmanifest не разобран.");
  const state = root.entries.find((entry) => entry.key.toLowerCase() === "appstate");
  if (!state || state.value.kind !== "obj") throw new Error("В appmanifest нет AppState.");
  setKey(state.value, "StateFlags", "4");
  setKey(state.value, "BytesToDownload", "0");
  setKey(state.value, "BytesDownloaded", String(Math.max(0, logicalBytes)));
  setKey(state.value, "FullValidateAfterNextUpdate", "0");
  return stringifyDocument(root);
}

export function retargetEpicManifest(text: string, installLocation: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Манифест Epic не объект.");
  parsed.InstallLocation = installLocation;
  return JSON.stringify(parsed);
}

export function steamGamePaths(libraryRoot: string, installdir: string, appId: number): { gameRoot: string; manifestPath: string } {
  const root = libraryRoot.replace(/[\\/]+$/, "");
  return {
    gameRoot: joinStyled(root, "steamapps", "common", installdir),
    manifestPath: joinStyled(root, "steamapps", `appmanifest_${appId}.acf`),
  };
}

export function joinStyled(root: string, ...parts: string[]): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

function libraryEntry(table: Extract<Vdf, { kind: "obj" }>, folder: string): Extract<Vdf, { kind: "obj" }> | null {
  for (const entry of table.entries) {
    if (entry.value.kind !== "obj") continue;
    const path = child(entry.value, "path");
    if (path?.kind === "str" && samePath(path.value, folder)) return entry.value;
  }
  return null;
}

function child(node: Extract<Vdf, { kind: "obj" }>, key: string): Vdf | null {
  return node.entries.find((entry) => entry.key.toLowerCase() === key.toLowerCase())?.value ?? null;
}

function setKey(node: Extract<Vdf, { kind: "obj" }>, key: string, value: string): void {
  const found = node.entries.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  if (found) found.value = { kind: "str", value };
  else node.entries.push({ key, value: { kind: "str", value } });
}

function samePath(left: string, right: string): boolean {
  const fold = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return fold(left) === fold(right);
}

function parseVdf(text: string): Vdf {
  const tokens = tokenize(text);
  let index = 0;
  if (tokens[index] === "{") {
    const node = parseNode();
    if (index !== tokens.length) throw new Error("В конце VDF остался лишний текст.");
    return node;
  }
  const entries: { key: string; value: Vdf }[] = [];
  while (index < tokens.length) {
    const key = tokens[index];
    if (!key || key === "{" || key === "}") throw new Error("У VDF нет ключа.");
    index += 1;
    const value: Vdf = tokens[index] === "{" ? parseNode() : { kind: "str", value: takeString() };
    entries.push({ key, value });
  }
  return { kind: "obj", entries };

  function parseNode(): Vdf {
    if (tokens[index] !== "{") throw new Error("Ожидался блок VDF.");
    index += 1;
    const entries: { key: string; value: Vdf }[] = [];
    while (index < tokens.length && tokens[index] !== "}") {
      const key = tokens[index];
      if (!key || key === "{") throw new Error("У блока VDF нет ключа.");
      index += 1;
      const value = tokens[index] === "{" ? parseNode() : { kind: "str" as const, value: takeString() };
      entries.push({ key, value });
    }
    if (tokens[index] !== "}") throw new Error("Блок VDF не закрыт.");
    index += 1;
    return { kind: "obj", entries };
  }

  function takeString(): string {
    const value = tokens[index];
    if (value == null || value === "{" || value === "}") throw new Error("Ожидалась строка VDF.");
    index += 1;
    return value;
  }
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && text[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push(value);
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push(char);
      index += 1;
      continue;
    }
    index += 1;
  }
  return tokens;
}

function stringifyDocument(node: Vdf): string {
  if (node.kind !== "obj") return `${stringifyVdf(node)}\n`;
  return `${node.entries
    .map((entry) => {
      if (entry.value.kind === "str") return `"${entry.key}"\t\t"${entry.value.value.replace(/"/g, '\\"')}"`;
      return `"${entry.key}"\n${stringifyVdf(entry.value, 0)}`;
    })
    .join("\n")}\n`;
}

function stringifyVdf(node: Vdf, indent = 0): string {
  if (node.kind === "str") return `"${node.value.replace(/"/g, '\\"')}"`;
  const pad = "\t".repeat(indent);
  const lines = ["{"];
  for (const entry of node.entries) {
    if (entry.value.kind === "str") lines.push(`${pad}\t"${entry.key}"\t\t"${entry.value.value.replace(/"/g, '\\"')}"`);
    else lines.push(`${pad}\t"${entry.key}"`, stringifyVdf(entry.value, indent + 1).split("\n").map((line, i) => (i === 0 ? `${pad}\t${line}` : line)).join("\n"));
  }
  lines.push(`${pad}}`);
  return lines.join("\n");
}
