import { AppShell } from "@/components/app-shell";
import { OpticalDesk } from "@/components/optical-desk";
import { OpticalPanel } from "@/components/optical-panel";

export default function OpticalPage() {
  return (
    <AppShell current="optical" subtitle="Диски DVD: образ, запись, полка">
      <OpticalDesk />
      <div className="mt-8 border-t pt-6">
        <h2 className="mb-3 text-base font-semibold">Рисунок на поверхности диска</h2>
        <OpticalPanel />
      </div>
    </AppShell>
  );
}
