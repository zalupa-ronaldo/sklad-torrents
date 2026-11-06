export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureLocalsend } = await import("@/lib/localsend/service");
  await ensureLocalsend();
  const { ensureSchedulerLoop } = await import("@/lib/scheduler/apply");
  ensureSchedulerLoop();
  const realOnly = process.env.SKLAD_REAL_ONLY === "1";
  if (!realOnly) {
    const { startDemoWorkers } = await import("@/lib/kernel/demo-worker");
    startDemoWorkers();
  }
  const { ensureAutomaticPolicies, safeTickAutomaticPlacement } = await import("@/lib/policies/auto-runner");
  await ensureAutomaticPolicies().catch((error) => {
    console.error("Автополитика Склада:", error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void safeTickAutomaticPlacement();
  }, 12_000);
  timer.unref?.();
  void safeTickAutomaticPlacement();
}
