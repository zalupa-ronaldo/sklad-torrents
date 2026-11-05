"use client";

import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-4 px-6">
      <p className="text-sm text-muted-foreground">Склад</p>
      <h1 className="text-2xl font-semibold tracking-tight">Интерфейс не открылся</h1>
      <p className="max-w-md text-sm text-muted-foreground">{error.message || "Неизвестная ошибка"}</p>
      <Button onClick={reset}>Повторить</Button>
    </main>
  );
}
