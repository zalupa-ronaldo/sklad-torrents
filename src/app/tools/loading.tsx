export default function Loading() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-live="polite">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/70" />
      <div className="h-24 animate-pulse rounded-lg bg-muted/70" />
      <p className="text-sm text-muted-foreground">Загружаем очередь…</p>
    </div>
  );
}
