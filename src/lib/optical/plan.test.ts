import { describe, expect, it } from "vitest";

import { planOptical } from "@/lib/optical/plan";
import type { IndexedPath, MediaKind } from "@/lib/optical/media";

const file: IndexedPath = {
  diskLabel: "Vault",
  path: "/Volumes/vault/Music/NieR Automata OST/booklet.pdf",
  name: "booklet.pdf",
  size: 12_000_000,
  kind: "file",
};

function burn(media: MediaKind, eraseConfirmed: boolean, platform: "darwin" | "win32" = "darwin") {
  return planOptical({
    action: "burn",
    platform,
    media,
    eraseConfirmed,
    device: platform === "darwin" ? "/dev/disk2" : "E:",
    driveIndex: "1",
    files: [file],
    outputDir: platform === "darwin" ? "/Volumes/vault/Cinema" : "D:\\Archive",
    label: "Саундтрек",
  });
}

describe("rewritable burn plan", () => {
  it.each(["cd-rw", "dvd-rw", "dvd+rw"] as const)("keeps erase false for %s unless confirm is stored", (media) => {
    const plan = burn(media, false);
    expect(plan.erase).toBe(false);
    const argv = plan.steps.flatMap((step) => step.argv);
    expect(argv).not.toContain("-erase");
    expect(argv).not.toContain("-fullerase");
    expect(argv.join(" ")).not.toContain("bulkerase");
    expect(argv).not.toContain("-Erase:$true");
  });

  it("passes -erase only after the confirm flag is set", () => {
    const plan = burn("dvd-rw", true);
    expect(plan.erase).toBe(true);
    const burnStep = plan.steps.find((step) => step.phase === "запись");
    expect(burnStep?.argv).toContain("-erase");
  });

  it("ignores confirm on write-once media", () => {
    const plan = burn("dvd-r", true);
    expect(plan.erase).toBe(false);
    expect(plan.steps.flatMap((step) => step.argv)).not.toContain("-erase");
  });

  it("plans Windows oscdimg and IMAPI with erase forced off", () => {
    const plan = burn("dvd+rw", false, "win32");
    expect(plan.erase).toBe(false);
    const argv = plan.steps.flatMap((step) => step.argv);
    expect(argv).toContain("oscdimg");
    expect(argv.some((arg) => arg.endsWith("imapi-burn.ps1"))).toBe(true);
    expect(argv.some((arg) => arg.endsWith("imapi-verify.ps1"))).toBe(true);
    expect(argv).toContain("-Erase:$false");
    expect(argv).not.toContain("-Erase:$true");
    expect(argv).not.toContain("-Erase");
  });

  it("plans macOS hdiutil and drutil without an erase flag", () => {
    const plan = burn("dvd-rw", false, "darwin");
    const argv = plan.steps.flatMap((step) => step.argv);
    expect(argv).toContain("hdiutil");
    expect(argv).toContain("makehybrid");
    expect(argv).toContain("checksum");
    expect(argv).toContain("drutil");
    expect(argv).toContain("-noverifyburn");
    expect(argv).not.toContain("-erase");
  });
});
