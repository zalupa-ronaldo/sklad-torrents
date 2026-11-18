import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { accountReadings, bindProbeRows, buildProbeReport, clipDiag, compressionProbeScript, decideCompact, decodeCompactOutput, encodePowerShellCommand, enumerateProbePaths, finishMeasurement, listOwnedFiles, measureDebugRequested, parseCompactListing, parseCompactSummary, parseSizeProbeOutput, powershellProbeArgs, readingsFromQuery, reconcileOwnedRoot, serializeProbePaths, stripPowerShellNoise, windowsPowershellCandidates, type OwnedFile, type WofState } from "@/lib/games/compact-measure";
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

const RUSSIAN_SUMMARY_CP866 = Buffer.from(
  "82e1a5a3ae20e4a0a9abaea23a20352c20aaa0e2a0abaea3aea23a20312e0d0a88a720ada8e520e1a6a0e2ae3a20312c20ada520e1a6a0e2ae3a20342e0d0a84a0adadeba520aea1eaa5acaeac2031ff303532ff33353420a1a0a9e220e1aee5e0a0ada5adeb20a2203430ff36343220a1a0a9e22e0d0a",
  "hex",
);
const RUSSIAN_SUMMARY_CP1251 = Buffer.from(
  "c2f1e5e3ee20f4e0e9ebeee23a20352c20eae0f2e0ebeee3eee23a20312e0d0ac8e720ede8f520f1e6e0f2ee3a20312c20ede520f1e6e0f2ee3a20342e0d0ac4e0ededfbe520eee1fae5eceeec2031a0303532a033353420e1e0e9f220f1eef5f0e0ede5edfb20e2203430a036343220e1e0e9f22e0d0a",
  "hex",
);
const RUSSIAN_LINE_CP866 = Buffer.from(
  "202020203336383634203a202031303438353736203d2032382c3420aa203120585052455353384b207061796c6f61642e62696e0d0a",
  "hex",
);

const ownedRoot: OwnedFile[] = [
  { relative: "payload.bin", full: "D:\\pool\\payload.bin", logical: 1_048_576 },
  { relative: "b.bin", full: "D:\\pool\\b.bin", logical: 2_000 },
  { relative: "c.bin", full: "D:\\pool\\c.bin", logical: 1_000 },
  { relative: "d.bin", full: "D:\\pool\\d.bin", logical: 742 },
];

function ownedSizes(): Map<string, number | null> {
  return new Map([
    ["D:\\pool\\payload.bin", 36_864],
    ["D:\\pool\\b.bin", 2_000],
    ["D:\\pool\\c.bin", 1_000],
    ["D:\\pool\\d.bin", 742],
  ]);
}

function ownedWof(): Map<string, WofState> {
  return new Map([
    ["D:\\pool\\payload.bin", { wof: 36_864, algorithm: "XPRESS8K" }],
    ["D:\\pool\\b.bin", { wof: 0, algorithm: null }],
    ["D:\\pool\\c.bin", { wof: 0, algorithm: null }],
    ["D:\\pool\\d.bin", { wof: 0, algorithm: null }],
  ]);
}

it("decodes a cp866 Russian compact /Q summary whose thousands separator is NBSP", () => {
  const decoded = decodeCompactOutput(RUSSIAN_SUMMARY_CP866);
  expect(decoded).toMatch(/Данные объемом/);
  expect(decoded).toContain("\u00a0");
  expect(parseCompactSummary(Buffer.from(RUSSIAN_SUMMARY_CP866).toString("utf8")).logical).toBeNull();
  expect(parseCompactSummary(decoded)).toEqual({ fileCount: 5, compressedCount: 1, logical: 1_052_354, stored: 40_642 });
  expect(parseCompactSummary(decodeCompactOutput(RUSSIAN_SUMMARY_CP1251))).toEqual({
    fileCount: 5,
    compressedCount: 1,
    logical: 1_052_354,
    stored: 40_642,
  });
  const line = decodeCompactOutput(RUSSIAN_LINE_CP866);
  expect(parseCompactListing(line).get("payload.bin")).toEqual({ logical: 1_048_576, stored: 36_864, wof: 36_864 });
  expect(parseCompactListing("    36864 :  1048576 = 28,4 к 1 XPRESS8K payload.bin").get("payload.bin")?.wof).toBe(36_864);
});

it("trusts per-file WOF sizes when the compact summary also counts .sklad-managed", () => {
  const summary = parseCompactSummary(decodeCompactOutput(RUSSIAN_SUMMARY_CP866));
  const account = reconcileOwnedRoot({
    files: ownedRoot,
    sizes: ownedSizes(),
    wofState: ownedWof(),
    summary,
    perFile: new Map(),
    markerBytes: 36,
    markerFiles: 1,
  });
  expect(account).toMatchObject({
    known: true,
    compressed: true,
    files: 4,
    logical: 1_052_318,
    allocated: 40_606,
    wof: 36_864,
  });
  expect(account.reason).toMatch(/GetCompressedFileSizeW/);
  expect(account.reason).toMatch(/\.sklad-managed/);
  expect(account.reason).not.toMatch(/не содержит сводку/);

  const unread = reconcileOwnedRoot({
    files: ownedRoot,
    sizes: ownedSizes(),
    wofState: ownedWof(),
    summary: { fileCount: null, compressedCount: null, logical: null, stored: null },
    perFile: new Map(),
  });
  expect(unread).toMatchObject({ known: true, compressed: true, logical: 1_052_318, allocated: 40_606, wof: 36_864 });
  expect(unread.reason).not.toMatch(/не содержит сводку/);

  const unknownWof = new Map<string, WofState>(ownedRoot.map((file) => [file.full, { wof: null, algorithm: null }]));
  const sized = reconcileOwnedRoot({
    files: ownedRoot,
    sizes: ownedSizes(),
    wofState: unknownWof,
    summary,
    perFile: new Map(),
    markerBytes: 36,
    markerFiles: 1,
  });
  expect(sized).toMatchObject({ known: true, compressed: true, logical: 1_052_318, allocated: 40_606, wof: 36_864 });
  expect(sized.reason).toMatch(/GetCompressedFileSizeW/);

  const fallback = reconcileOwnedRoot({
    files: ownedRoot,
    sizes: new Map(),
    summary,
    perFile: new Map(),
    markerBytes: 36,
    markerFiles: 1,
  });
  expect(fallback).toMatchObject({ known: false, compressed: false, logical: 1_052_318, allocated: 40_606, wof: null });
  expect(fallback.reason).toMatch(/не весь allocated/);
});

it("finds powershell.exe under SystemRoot and does not read PATH", () => {
  expect(windowsPowershellCandidates({ PATH: "", Path: "C:\\missing" } as unknown as NodeJS.ProcessEnv)).toEqual([
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);
  expect(windowsPowershellCandidates({ SystemRoot: "D:\\WinNT", PATH: "C:\\no-powershell" } as unknown as NodeJS.ProcessEnv)[0]).toBe(
    "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const script = compressionProbeScript();
  expect(script).toMatch(/GetCompressedFileSizeW/);
  expect(script).toMatch(/Write-Output/);
  expect(script).not.toMatch(/OpenStandardOutput/);
  expect(script).toMatch(/\$ProgressPreference = 'SilentlyContinue'/);
  expect(script).toMatch(/try \{ \[Console\]::OutputEncoding = \$utf8 \} catch \{\}/);
  expect(script).toMatch(/SKLAD_COMPACT_OUT/);
  expect(script).toMatch(/"index":/);
  expect(script).toMatch(/GetFileInformationByHandleEx/);
  expect(script).toMatch(/0x90310/);
  expect(script).toMatch(/0x80000017/);
  expect(script).not.toMatch(/powershell\.exe/);
  const args = powershellProbeArgs(script);
  expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  expect(args).not.toContain("-Command");
  expect(Buffer.from(args[5]!, "base64").toString("utf16le")).toBe(script);
  expect(encodePowerShellCommand("Write-Output 1")).toBe(Buffer.from("Write-Output 1", "utf16le").toString("base64"));
});

const NATIVE_Q_CP866 = Buffer.from(
  "0d0a208fe0aee1acaee2e020aaa0e2a0abaea3a020433a5c55736572735c757365725c2e6c6f63616c5c736b6c61642d6d6561737572652d32303236313131382d37656664383537662d31393635656166325c66697874757265735c706f6f6c5c67616d652d3938613462663031396666645c0d0a208daea2eba520e4a0a9abeb2c20a4aea1a0a2abefa5aceba520a220ede2aee220aaa0e2a0abaea32c20ada520a1e3a4e3e220e1a6a0e2eb2e0d0a0d0a0d0a82e1a5a3ae20e4a0a9abaea23a20332c20aaa0e2a0abaea3aea23a20312e0d0a88a720ada8e520e1a6a0e2ae3a20312c20ada520e1a6a0e2ae3a20322e0d0a84a0adadeba520aea1eaa5acaeac2031ff303438ff36393920a1a0a9e220e1aee5e0a0ada5adeb20a2203336ff39383720a1a0a9e22e0d0a91e2a5afa5adec20e1a6a0e2a8ef2032382c3420aa20312e0d0a0d0a",
  "hex",
);

const nativeRoot: OwnedFile[] = [
  { relative: "payload.bin", full: "C:\\pool\\game\\payload.bin", logical: 1_048_576 },
  { relative: "sklad-game.json", full: "C:\\pool\\game\\sklad-game.json", logical: 97 },
];

it("accepts the native PR25 compact /Q sample when the marker is 26 bytes and the probe is empty", () => {
  const text = decodeCompactOutput(NATIVE_Q_CP866);
  expect(parseCompactSummary(Buffer.from(NATIVE_Q_CP866).toString("utf8")).logical).toBeNull();
  expect(parseCompactSummary(text)).toEqual({ fileCount: 3, compressedCount: 1, logical: 1_048_699, stored: 36_987 });
  const summary = parseCompactSummary(text);
  const missed = reconcileOwnedRoot({
    files: nativeRoot,
    sizes: new Map(),
    summary,
    perFile: new Map(),
    markerBytes: 26,
    markerFiles: 1,
  });
  expect(missed).toMatchObject({ known: false, compressed: false, files: 2, logical: 1_048_673, allocated: 36_961, wof: null });
  expect(missed.reason).toMatch(/подложкой WOF/);
  expect(missed.reason).not.toMatch(/WOF 36961/);
  expect(missed.reason).not.toMatch(/CLIXML/);

  const sized = reconcileOwnedRoot({
    files: nativeRoot,
    sizes: new Map([
      ["C:\\pool\\game\\payload.bin", 36_864],
      ["C:\\pool\\game\\sklad-game.json", 97],
    ]),
    summary,
    perFile: new Map(),
    markerBytes: 26,
    markerFiles: 1,
  });
  expect(sized).toMatchObject({ known: true, compressed: true, logical: 1_048_673, allocated: 36_961, wof: 36_864 });

  const probed = finishMeasurement({
    files: nativeRoot,
    markerBytes: 26,
    markerFiles: 1,
    sizes: { ok: false, values: new Map(), states: new Map(), note: "GetCompressedFileSizeW не вернул ни одной строки." },
    queryText: text,
    queryOk: true,
    queryNote: "",
  });
  expect(probed).toMatchObject({ known: false, compressed: false, logical: 1_048_673, allocated: 36_961, wof: null });
  expect(probed.reason).not.toMatch(/CLIXML/);
  expect(probed.reason).not.toMatch(/не совпала/);

  const utf8 = Buffer.from('{"path":"C:\\\\pool\\\\game\\\\payload.bin","allocated":36864,"wof":36864,"algorithm":"XPRESS8K"}\n', "utf8");
  const utf16 = Buffer.from('{"path":"C:\\\\pool\\\\game\\\\payload.bin","allocated":36864,"wof":36864,"algorithm":"XPRESS8K"}\n', "utf16le");
  for (const buf of [utf8, utf16]) {
    expect(parseSizeProbeOutput(buf).rows).toEqual([{ index: null, path: "C:\\pool\\game\\payload.bin", allocated: 36_864, wof: 36_864, algorithm: "XPRESS8K" }]);
  }
  expect(parseSizeProbeOutput(Buffer.alloc(0)).ok).toBe(false);
});

it("counts only WOF-backed files and drops a PowerShell progress record from the reason", () => {
  const clixml = '#< CLIXML <Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR';
  const payload = '{"path":"C:\\\\pool\\\\game\\\\payload.bin","allocated":36864,"wof":36864,"algorithm":"XPRESS8K"}\n';
  const json = '{"path":"C:\\\\pool\\\\game\\\\sklad-game.json","allocated":97,"wof":0}\n';
  const parsed = parseSizeProbeOutput(Buffer.from(`${clixml}\n${payload}${json}`, "utf8"));
  expect(parsed.ok).toBe(true);
  expect(parsed.rows).toEqual([
    { index: null, path: "C:\\pool\\game\\payload.bin", allocated: 36_864, wof: 36_864, algorithm: "XPRESS8K" },
    { index: null, path: "C:\\pool\\game\\sklad-game.json", allocated: 97, wof: 0, algorithm: null },
  ]);
  const text = decodeCompactOutput(NATIVE_Q_CP866);
  const account = finishMeasurement({
    files: nativeRoot,
    markerBytes: 26,
    markerFiles: 1,
    sizes: {
      ok: false,
      values: new Map([
        ["C:\\pool\\game\\payload.bin", 36_864],
        ["C:\\pool\\game\\sklad-game.json", 97],
      ]),
      states: new Map([
        ["C:\\pool\\game\\payload.bin", { wof: 36_864, algorithm: "XPRESS8K" }],
        ["C:\\pool\\game\\sklad-game.json", { wof: 0, algorithm: null }],
      ]),
      note: clixml,
    },
    queryText: text,
    queryOk: true,
    queryNote: "",
  });
  expect(account).toMatchObject({ known: true, compressed: true, logical: 1_048_673, allocated: 36_961, wof: 36_864 });
  expect(account.reason).toMatch(/WOF 36864/);
  expect(account.reason).not.toMatch(/CLIXML/);
  expect(account.reason).not.toMatch(/<Objs/);
  expect(account.reason).not.toMatch(/S="progress"/);
  expect(stripPowerShellNoise(`Имя алгоритма в сводке не названо. ${clixml}`)).toBe("Имя алгоритма в сводке не названо.");
  expect(clipDiag(clixml)).toBe("");
});

it("parses a Windows PowerShell 5.1 stdout capture and ignores CLIXML on stderr", () => {
  const lines = [
    '{"path":"C:\\\\pool\\\\game\\\\payload.bin","allocated":36864,"wof":36864,"algorithm":"XPRESS8K"}\r\n',
    '{"path":"C:\\\\pool\\\\game\\\\sklad-game.json","allocated":97,"wof":0,"algorithm":null}\r\n',
  ].join("");
  const utf16 = Buffer.from(lines, "utf16le");
  const utf8 = Buffer.from(lines, "utf8");
  const expected = [
    { index: null, path: "C:\\pool\\game\\payload.bin", allocated: 36_864, wof: 36_864, algorithm: "XPRESS8K" },
    { index: null, path: "C:\\pool\\game\\sklad-game.json", allocated: 97, wof: 0, algorithm: null },
  ];
  expect(parseSizeProbeOutput(utf16).rows).toEqual(expected);
  expect(parseSizeProbeOutput(utf8).rows).toEqual(expected);
  const stderr = '#< CLIXML <Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64>';
  expect(parseSizeProbeOutput(utf16).rows).toEqual(expected);
  const script = compressionProbeScript();
  const report = buildProbeReport({
    exitCode: 0,
    stdout: utf16,
    stderr,
    stderrBytes: Buffer.byteLength(stderr),
    powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: powershellProbeArgs(script),
    script,
    rows: parseSizeProbeOutput(utf16).rows.length,
  });
  expect(report.exitCode).toBe(0);
  expect(report.stdoutBytes).toBe(utf16.length);
  expect(report.rows).toBe(2);
  expect(report.stderr).toBe("");
  expect(report.stderrBytes).toBeGreaterThan(0);
  expect(report.argv[4]).toBe("-EncodedCommand");
  expect(Buffer.from(report.argv[5]!, "base64").toString("utf16le")).toBe(script);
  expect(report.script).toContain("Write-Output");
  expect(report.stdoutPreview).toContain("payload.bin");
  expect(report.stdoutPreview).not.toMatch(/CLIXML/);
  expect(measureDebugRequested(["--debug-probe"], {} as unknown as NodeJS.ProcessEnv)).toBe(true);
  expect(measureDebugRequested([], { SKLAD_COMPACT_DEBUG: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  expect(measureDebugRequested([], { SKLAD_COMPACT_DEBUG: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
});

it("passes each probe path separately, including spaces, quotes and Cyrillic", () => {
  const files = [
    "C:\\Games\\Моя игра\\payload.bin",
    "D:\\Pool\\My Game\\sklad-game.json",
    "C:\\Games\\file \"1\".bin",
    "\\\\?\\D:\\Архив\\очень длинный каталог\\data.bin",
  ];
  const enumerated = enumerateProbePaths(JSON.parse(serializeProbePaths(files)));
  expect(enumerated).toEqual(files);
  expect(enumerated).toHaveLength(4);
  expect(enumerated).not.toContain(files.join(" "));
  expect(enumerateProbePaths(files[0])).toEqual([files[0]]);
  const script = compressionProbeScript();
  expect(script).toMatch(/ConvertFrom-Json -InputObject/);
  expect(script).toMatch(/SKLAD_COMPACT_LIST/);
  expect(script).toMatch(/-is \[System\.Array\]/);
  expect(script).not.toMatch(/SKLAD_COMPACT_FILES \| ConvertFrom-Json/);
});

it("binds Cyrillic paths with spaces by index when stdout replaced them with U+FFFD", () => {
  const files: OwnedFile[] = [
    { relative: "данные 1.bin", full: "D:\\Тест пул\\данные 1.bin", logical: 1_048_576 },
    { relative: "sklad-game.json", full: "D:\\Тест пул\\sklad-game.json", logical: 99 },
  ];
  const stdout = Buffer.from(
    '{"index":0,"path":"???? ??\\\\????? 1.bin","allocated":36864,"wof":36864,"algorithm":"XPRESS8K"}\n{"index":1,"path":"???? ??\\\\sklad-game.json","allocated":99,"wof":0,"algorithm":null}\n',
    "utf8",
  );
  const parsed = parseSizeProbeOutput(stdout);
  expect(parsed.rows.map((row) => row.path).join(" ")).toMatch(/\uFFFD|\?/);
  const bound = bindProbeRows(files.map((file) => file.full), parsed.rows);
  const account = reconcileOwnedRoot({
    files,
    sizes: bound.values,
    wofState: bound.states,
    summary: { fileCount: 3, compressedCount: 1, logical: 1_048_701, stored: 36_989 },
    perFile: new Map(),
    markerBytes: 26,
    markerFiles: 1,
  });
  expect(account).toMatchObject({ known: true, compressed: true, logical: 1_048_675, allocated: 36_963, wof: 36_864 });
  expect(bound.values.get("D:\\Тест пул\\данные 1.bin")).toBe(36_864);
  expect(bound.values.get("D:\\Тест пул\\sklad-game.json")).toBe(99);
  expect(serializeProbePaths(files.map((file) => file.full))).toContain("данные 1.bin");
  expect(serializeProbePaths(files.map((file) => file.full))).toContain("Тест пул");
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

  const marked = await mkdtemp(path.join(tmpdir(), "sklad-compact-"));
  await writeFile(path.join(marked, "payload.bin"), Buffer.alloc(8));
  await writeFile(path.join(marked, ".sklad-managed"), Buffer.alloc(36));
  const owned = await listOwnedFiles(marked);
  expect(owned.ok).toBe(true);
  if (!owned.ok) return;
  expect(owned.files.map((file) => file.relative)).toEqual(["payload.bin"]);
  expect(owned.files[0]?.logical).toBe(8);
  expect(owned.markerBytes).toBe(36);
  expect(owned.markerFiles).toBe(1);
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
