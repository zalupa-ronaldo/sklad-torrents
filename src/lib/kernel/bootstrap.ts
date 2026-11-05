import { ensureDemoCatalog } from "@/lib/kernel/catalog";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { withLock } from "@/lib/kernel/lock";
import { ensureDemoPolicy } from "@/lib/kernel/policies";
import { ensureDemoPrefs } from "@/lib/kernel/scheduler-run";
import { ensureDemoSettings } from "@/lib/kernel/media";
import { demoJobs } from "@/lib/kernel/demo-seed";

export async function ensureDemoJobs(): Promise<void> {
  await withLock("jobs", async () => {
    const existing = await readJsonFile<{ jobs: unknown[] }>("jobs.json");
    if (existing) return;
    await writeJsonFile("jobs.json", { jobs: demoJobs() });
  });
}

export async function ensureDemoState(): Promise<void> {
  await ensureDemoCatalog();
  await ensureDemoPolicy();
  await ensureDemoSettings();
  await ensureDemoPrefs();
  await ensureDemoJobs();
}
