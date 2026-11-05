import { describe, expect, it } from "vitest";

import { formatBytes, formatSpeed } from "@/lib/format";
import type { JobSnapshot } from "@/lib/progress/types";
import { toJobCard, toJobCards } from "@/lib/progress/view";

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "copy-control",
    kind: "copy",
    title: "Control → SSD",
    status: "running",
    progress: 0.425,
    processedBytes: 4_250_000_000,
    totalBytes: 10_000_000_000,
    speed: 50_000_000,
    eta: 125,
    currentFile: "data/pack0.pack",
    host: "Windows PC",
    diskLabel: "SSD",
    outputPath: "C:\\Games\\Control Ultimate Edition",
    error: null,
    capabilities: { pause: true, resume: false, cancel: true },
    pauseUnsupportedReason: null,
    updatedAt: 0,
    ...overrides,
  };
}

describe("job view model", () => {
  it("renders percent, ETA, byte counters, and the actions the engine allows", () => {
    const card = toJobCard(snapshot());
    expect(card.percentLabel).toBe("42,5%");
    expect(card.percent).toBeCloseTo(42.5);
    expect(card.etaLabel).toBe("осталось 2 мин");
    expect(card.bytesLabel).toBe(`${formatBytes(4_250_000_000)} из ${formatBytes(10_000_000_000)}`);
    expect(card.bytesLabel).toMatch(/из/);
    expect(card.bytesLabel).toMatch(/ГБ/);
    expect(card.speedLabel).toBe(formatSpeed(50_000_000));
    expect(card.speedLabel).toMatch(/\/с$/);
    expect(card.canPause).toBe(true);
    expect(card.canResume).toBe(false);
    expect(card.canCancel).toBe(true);
    expect(card.pauseNote).toBeNull();
    expect(card.currentFile).toBe("data/pack0.pack");
    expect(card.host).toBe("Windows PC");
    expect(card.diskLabel).toBe("SSD");
    expect(card.outputPath).toBe("C:\\Games\\Control Ultimate Edition");
  });

  it("hides pause and explains that the engine cannot pause", () => {
    const card = toJobCard(
      snapshot({
        id: "compact-gow",
        kind: "compact",
        title: "CompactGUI — God of War",
        capabilities: { pause: false, resume: false, cancel: true },
        pauseUnsupportedReason: "Движок не умеет паузу",
      }),
    );
    expect(card.canPause).toBe(false);
    expect(card.canResume).toBe(false);
    expect(card.canCancel).toBe(true);
    expect(card.pauseNote).toBe("Движок не умеет паузу");
  });

  it("enables resume only for a paused job and keeps an error off its neighbor", () => {
    const paused = snapshot({
      id: "index-vault",
      kind: "index",
      status: "paused",
      speed: 0,
      capabilities: { pause: false, resume: true, cancel: true },
    });
    const broken = snapshot({
      id: "transcode-broken",
      kind: "transcode",
      title: "HandBrake — битый исходник",
      status: "error",
      progress: 0.18,
      speed: 0,
      error: "HandBrake не открыл исходник",
      capabilities: { pause: false, resume: false, cancel: false },
      pauseUnsupportedReason: "Движок не умеет паузу",
    });
    const cards = toJobCards([broken, paused]);
    expect(cards[0]?.error).toBe("HandBrake не открыл исходник");
    expect(cards[0]?.statusLabel).toBe("Ошибка");
    expect(cards[0]?.canPause).toBe(false);
    expect(cards[0]?.pauseNote).toBeNull();
    expect(cards[1]?.canResume).toBe(true);
    expect(cards[1]?.canPause).toBe(false);
    expect(cards[1]?.canCancel).toBe(true);
    expect(cards[1]?.error).toBeNull();
    expect(cards[1]?.etaLabel).toBe("на паузе");
  });

  it("does not claim that cancel deleted files", () => {
    const card = toJobCard(
      snapshot({
        status: "cancelled",
        speed: 0,
        capabilities: { pause: false, resume: false, cancel: false },
      }),
    );
    expect(card.cancelNote).toBe("Остановлено. Файлы на диске не удалялись.");
    expect(card.canCancel).toBe(false);
    expect(card.canPause).toBe(false);
  });
});
