import { cn } from "@/lib/utils";
import { stateLabel, stateTone } from "@/lib/labels";
import type { NormalizedState } from "@/lib/qbittorrent/types";

const toneClass = {
  download: "bg-download/15 text-download",
  seed: "bg-seed/15 text-seed",
  warn: "bg-warn/15 text-warn",
  problem: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
} as const;

export function StateBadge({
  state,
  rawState,
  className,
}: {
  state: NormalizedState;
  rawState: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap",
        toneClass[stateTone(state)],
        className,
      )}
    >
      {stateLabel(state, rawState)}
    </span>
  );
}

export function progressColor(state: NormalizedState): string {
  switch (stateTone(state)) {
    case "download":
      return "bg-download";
    case "seed":
      return "bg-seed";
    case "warn":
      return "bg-warn";
    case "problem":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}
