import { setJobAdmission, setJobFailureClass } from "@/lib/jobs/engine";
import type { Job, JobHost } from "@/lib/jobs/model";

import { isChannelDetail } from "@/lib/progress/channel";
import { decideAdmission } from "@/lib/progress/control";

/** Called once from the job store. A paused task stays paused when the channel returns. */
export function bindAdmission(): void {
  setJobAdmission((host: JobHost, job: Job, running: readonly Job[]) => decideAdmission(host, job, running));
  setJobFailureClass((message: string) => (isChannelDetail(message) ? "channel" : "task"));
}
