import { readFile } from "node:fs/promises";
import path from "node:path";

/** Dev flag for `?demo=1`. Production, including the Docker panel, leaves it false. */
export function withDevFlag(html: string, nodeEnv: string | undefined): string {
  const dev = nodeEnv !== "production";
  const flag = `<script>window.SKLAD_DEV=${dev ? "true" : "false"};</script>`;
  if (html.includes("window.SKLAD_DEV=")) return html;
  return html.replace("</head>", `${flag}</head>`);
}

export async function prototypeHtml(nodeEnv: string | undefined = process.env.NODE_ENV): Promise<string> {
  const file = path.join(process.cwd(), "public", "prototype", "index.html");
  const html = await readFile(file, "utf8");
  return withDevFlag(html, nodeEnv);
}
