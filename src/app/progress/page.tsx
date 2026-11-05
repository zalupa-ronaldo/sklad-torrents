import { ProgressScreen } from "@/components/progress-screen";
import { getProgressPayload } from "@/lib/progress/jobs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Прогресс — Склад",
  description: "Загрузки, индексация, копирование, сжатие и перекодирование.",
};

export default async function ProgressPage() {
  const initial = await getProgressPayload();
  return <ProgressScreen initial={initial} />;
}
