import { JobScreen } from "@/components/job-screen";
import { getProgressPayload } from "@/lib/progress/jobs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Операция — Склад",
};

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = await getProgressPayload();
  return <JobScreen id={id} initial={initial} />;
}
