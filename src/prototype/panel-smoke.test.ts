import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GET } from "@/app/route";
import { withDevFlag } from "@/prototype/serve-home";

const root = process.cwd();

describe("panel home smoke", () => {
  const html = readFileSync(path.join(root, "public/prototype/index.html"), "utf8");

  it("serves the collection UI at / and keeps the previous UI at /legacy", async () => {
    expect(html).toContain('<base href="/prototype/">');
    expect(html).toContain("panel-adapter.js");
    expect(html).toContain("demo-data.js");
    expect(html).toContain("workbench.js");
    expect(html).toContain("app.js");
    expect(withDevFlag("<html><head></head><body></body></html>", "production")).toContain("window.SKLAD_DEV=false");
    expect(withDevFlag("<html><head></head><body></body></html>", "development")).toContain("window.SKLAD_DEV=true");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("panel-adapter.js");
    expect(body).toContain("window.SKLAD_DEV=");
    expect(body).not.toContain("window.SKLAD_DEV=false");
    const legacy = readFileSync(path.join(root, "src/app/legacy/page.tsx"), "utf8");
    expect(legacy).toContain("Dashboard");
    const nav = readFileSync(path.join(root, "src/components/app-nav.tsx"), "utf8");
    expect(nav).toContain('href: "/legacy"');
    expect(readFileSync(path.join(root, "public/prototype/app.js"), "utf8")).toContain("PanelAdapter.demoEnabled");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain("/legacy");
    expect(readFileSync(path.join(root, "docs/ustanovka.md"), "utf8")).toContain("/legacy");
  });
});
