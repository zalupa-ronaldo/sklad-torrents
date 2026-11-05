import { QueueScreen } from "@/components/queue-screen";
import { getProgressPayload } from "@/lib/progress/jobs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Очередь загрузок — Склад",
  description: "Одна активная загрузка на физический диск. Раздача не ограничена.",
};

export default async function SchedulerPage() {
  const initial = await getProgressPayload();
  return <QueueScreen initial={initial} />;
}
