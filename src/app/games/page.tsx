import { AppShell } from "@/components/app-shell";
import { WindowsLibraryScreen } from "@/app/games/windows-library-screen";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Игры — Склад",
  description: "Библиотека Windows: архив, пул «Играю сейчас», сжатие очередью.",
};

export default async function GamesPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const query = await searchParams;
  return (
    <AppShell current="games" subtitle="Windows">
      <WindowsLibraryScreen demo={query.demo === "1"} />
    </AppShell>
  );
}
