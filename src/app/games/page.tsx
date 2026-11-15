import { AppShell } from "@/components/app-shell";
import { GameLibraryPanel } from "@/addons/media-games/library-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Игры — Склад",
  description: "Библиотека игр по платформам: обложки, один запуск и перенос на SSD.",
};

export default function GamesPage() {
  return (
    <AppShell current="games" subtitle="Библиотека по платформам">
      <GameLibraryPanel />
    </AppShell>
  );
}
