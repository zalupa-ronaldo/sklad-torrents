import { ProgressScreen } from "@/components/progress-screen";
import { loadProgressPage } from "@/lib/progress/page-data";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Прогресс — Склад",
  description: "Загрузки, индексация, копирование, сжатие и перекодирование.",
};

export default async function ProgressPage() {
  const initial = await loadProgressPage();
  return <ProgressScreen initial={initial} />;
}
