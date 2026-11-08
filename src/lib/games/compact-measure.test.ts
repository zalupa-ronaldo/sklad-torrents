import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { accountReadings, clipDiag, decideCompact, listOwnedFiles, parseCompactListing, parseCompactSummary, readingsFromQuery, reconcileOwnedRoot, type OwnedFile } from "@/lib/games/compact-measure";
import { localJobHost, hostFacts } from "@/lib/jobs/local-host";

const smoke = "    36864 :  1048576 = 28.4 to 1 XPRESS8K payload.bin";

it("accounts the measured Windows root and does not turn an unknown size into zero", () => {
  const listing = parseCompactListing(`${smoke}\n1,048,576 total bytes of data are stored in 36,864 bytes.\n`);
  const files: OwnedFile[] = [{ relative: "payload.bin", full: "D:\\pool\\payload.bin", logical: 1_048_576 }];
  const sizes = new Map([[files[0]!.full, 36864]]);
  const account = accountReadings(readingsFromQuery(files, sizes, listing));
  expect(account).toMatchObject({ known: true, compressed: true, logical: 1_048_576, allocated: 36864, wof: 36864, files: 1 });
  expect(accountReadings(readingsFromQuery(files, sizes, listing))).toEqual(account);

  const same = parseCompactListing("    1048576 :  1048576 = 1.0 to 1 C payload.bin");
  const flat = accountReadings(readingsFromQuery(files, new Map([[files[0]!.full, 1_048_576]]), same));
  expect(flat).toMatchObject({ known: true, compressed: false, allocated: 1_048_576, wof: 0 });
  expect(flat.reason).toMatch(/равен/);

  const missing = accountReadings(readingsFromQuery(files, new Map([[files[0]!.full, null]]), listing));
  expect(missing.allocated).toBeNull();
  expect(missing.wof).toBeNull();
  expect(missing.compressed).toBe(false);
  expect(decideCompact({ files: 1, logical: 100, allocated: 40, wof: null }).allocated).toBe(40);
  expect(decideCompact({ files: 1, logical: 100, allocated: 40, wof: null }).known).toBe(false);
});

it("reads the Russian compact /Q summary that has no per-file line", () => {
  const text = "\uFEFF\r\nВсего файлов: 1, каталогов: 1.\r\nИз них сжато: 1, не сжато: 0.\r\nДанные объемом 1\u00a0048\u00a0576 байт сохранены в 36\u00a0864 байт.\r\n";
  expect(parseCompactListing(text).size).toBe(0);
  expect(parseCompactSummary(text)).toEqual({ fileCount: 1, compressedCount: 1, logical: 1_048_576, stored: 36_864 });
  const files: OwnedFile[] = [{ relative: "payload.bin", full: "D:\\pool\\payload.bin", logical: 1_048_576 }];
  const agreed = reconcileOwnedRoot({
    files,
    sizes: new Map([[files[0]!.full, 36_864]]),
    summary: parseCompactSummary(text),
    perFile: parseCompactListing(text),
  });
  expect(agreed).toMatchObject({ known: true, compressed: true, logical: 1_048_576, allocated: 36_864, wof: 36_864 });
  const mismatch = reconcileOwnedRoot({
    files,
    sizes: new Map([[files[0]!.full, 1_048_576]]),
    summary: parseCompactSummary(text),
    perFile: parseCompactListing(text),
  });
  expect(mismatch.compressed).toBe(false);
  expect(mismatch.logical).toBe(1_048_576);
  expect(mismatch.reason).toMatch(/36864/);
  expect(mismatch.reason).toMatch(/1048576/);
  expect(clipDiag("fail C:\\Users\\user\\secret\\payload.bin")).toBe("fail <path>");
});

it("stops at a symlink and at E: before reading a file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sklad-compact-"));
  await writeFile(path.join(root, "payload.bin"), "x");
  await symlink(path.join(root, "payload.bin"), path.join(root, "link.bin"));
  const linked = await listOwnedFiles(root);
  expect(linked.ok).toBe(false);
  if (!linked.ok) expect(linked.reason).toMatch(/symlink/);

  const closed = await listOwnedFiles("E:\\Games\\Owned");
  expect(closed.ok).toBe(false);
  if (!closed.ok) expect(closed.reason).toMatch(/E и Z/);
});

it("names the process platform and leaves the other hosts unconfigured", () => {
  expect(localJobHost("darwin")).toBe("mac-local");
  expect(localJobHost("win32")).toBe("pc-agent");
  expect(localJobHost("linux")).toBe("linux-local");
  expect(localJobHost("freebsd")).toBeNull();
  const mac = hostFacts("darwin");
  expect(mac.find((item) => item.host === "mac-local")).toMatchObject({ state: "local" });
  expect(mac.find((item) => item.host === "linux-local")?.reason).toMatch(/не запускался/);
  expect(mac.find((item) => item.host === "pc-agent")?.state).toBe("unconfigured");
});
