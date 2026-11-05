import { IntegrityDetail } from "@/components/integrity-detail";
import { JobScreen } from "@/components/job-screen";
import { getProgressPayload } from "@/lib/progress/jobs";

export const dynamic = "force-dynamic";

export default async function ProgressJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decoded = safeDecode(id);
  if (decoded.startsWith("hash-")) return <IntegrityDetail id={decoded} />;
  const initial = await getProgressPayload();
  return <JobScreen id={decoded} initial={initial} />;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
