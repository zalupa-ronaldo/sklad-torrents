import type { Page } from "@/lib/kernel/types";

export function pageOf<T>(items: T[], offset = 0, limit = 50): Page<T> {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || 50));
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
  };
}
