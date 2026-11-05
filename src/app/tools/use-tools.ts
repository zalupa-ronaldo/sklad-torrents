"use client";

import { useCallback, useEffect, useState } from "react";

import type { ToolsSnapshot } from "@/addons/media-games/types";
import { api } from "@/lib/api-client";

export function useToolsSnapshot(poll: boolean) {
  const [data, setData] = useState<ToolsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api<ToolsSnapshot>("/api/tools");
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить инструменты");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const kick = window.setTimeout(() => void refresh(), 0);
    if (!poll) {
      return () => window.clearTimeout(kick);
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1200);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [poll, refresh]);

  return { data, error, loading, refresh };
}
