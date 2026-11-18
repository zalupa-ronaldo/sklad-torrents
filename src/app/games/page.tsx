import { GamesRedirect } from "@/app/games/games-redirect";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Игры — Склад",
  description: "Библиотека Windows: архив, пул «Играю сейчас», сжатие очередью.",
};

export default async function GamesPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const query = await searchParams;
  return <GamesRedirect demo={query.demo === "1"} />;
}
