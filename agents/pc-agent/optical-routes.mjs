import { claimAndExecute, MOCK_DRIVES } from "./protocol.mjs";

const jobs = new Map();

/**
 * Optical routes on the Windows agent. Mock mode never burns a disc.
 * Live burn, drive detection, and verify are claimed only here.
 */
export async function handleOptical(req, url, readBody) {
  const parts = url.pathname.split("/").filter(Boolean);
  const mock = process.env.SKLAD_PC_AGENT_MOCK !== "0";
  if (req.method === "GET" && parts.length === 3 && parts[2] === "drives") {
    return { status: 200, body: { host: "pc-agent", drives: MOCK_DRIVES, physicalDiscBurned: false } };
  }
  if (req.method === "GET" && parts[2] === "drives" && parts[3]) {
    const drive = MOCK_DRIVES.find((item) => item.id === decodeURIComponent(parts[3]));
    if (!drive) return { status: 404, body: { error: "Агент Windows не нашёл такой привод." } };
    return { status: 200, body: drive };
  }
  if (req.method === "POST" && parts.length === 3 && parts[2] === "jobs") {
    const job = await readBody(req);
    if (!job || typeof job !== "object" || typeof job.id !== "string") {
      return { status: 400, body: { error: "Агенту Windows нужно задание с id." } };
    }
    try {
      const result = claimAndExecute(job, {
        workerHost: "pc-agent",
        mock,
        drives: MOCK_DRIVES,
        priorJobs: [...jobs.values()],
      });
      jobs.set(result.id, result);
      return { status: 200, body: result };
    } catch (error) {
      const status = error?.code === "forbidden" ? 403 : 400;
      return { status, body: { error: error instanceof Error ? error.message : "Агент Windows отклонил задание." } };
    }
  }
  if (req.method === "GET" && parts[2] === "jobs" && parts[3]) {
    const job = jobs.get(decodeURIComponent(parts[3]));
    if (!job) return { status: 404, body: { error: "Задание на агенте Windows не найдено." } };
    return { status: 200, body: job };
  }
  return null;
}
