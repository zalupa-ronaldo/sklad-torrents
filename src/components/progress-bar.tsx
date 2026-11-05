import { progressColor } from "@/components/state-badge";
import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";
import type { NormalizedState } from "@/lib/qbittorrent/types";

export function ProgressBar({
  value,
  state,
  className,
}: {
  value: number;
  state: NormalizedState;
  className?: string;
}) {
  const width = Math.max(0, Math.min(100, (Number.isFinite(value) ? value : 0) * 100));
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      <div className={cn("h-full rounded-full", progressColor(state))} style={{ width: `${width}%` }} />
    </div>
  );
}

export function ProgressLabel({ value }: { value: number }) {
  return <span className="tabular-nums">{formatPercent(value)}</span>;
}
