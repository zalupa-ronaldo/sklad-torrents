import { SchedulerHome } from "@/app/scheduler/home";
import { getProgressPayload } from "@/lib/progress/jobs";
import { pipelineView } from "@/lib/scheduler/auto-queue";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Очередь загрузок — Склад",
  description: "Авторежим после диска или торрента и одна активная загрузка на физический диск.",
};

export default async function SchedulerPage() {
  const [initial, pipeline] = await Promise.all([getProgressPayload(), pipelineView()]);
  return <SchedulerHome initial={initial} pipeline={pipeline} />;
}
