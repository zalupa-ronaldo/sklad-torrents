export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureLocalsend } = await import("@/lib/localsend/service");
  await ensureLocalsend();
  const { ensureSchedulerLoop } = await import("@/lib/scheduler/apply");
  ensureSchedulerLoop();
  const { startDemoWorkers } = await import("@/lib/kernel/demo-worker");
  startDemoWorkers();
}
