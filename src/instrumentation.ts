export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureLocalsend } = await import("@/lib/localsend/service");
  await ensureLocalsend();
  const realOnly = process.env.SKLAD_REAL_ONLY === "1";
  if (!realOnly) {
    const { startDemoWorkers } = await import("@/lib/kernel/demo-worker");
    startDemoWorkers();
  }
  const { ensureGameModeBridge } = await import("@/lib/game-mode/bridge");
  ensureGameModeBridge();
}
