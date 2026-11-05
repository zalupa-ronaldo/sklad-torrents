import { AppShell } from "@/components/app-shell";
import { OpticalPanel } from "@/components/optical-panel";

export default function OpticalPage() {
  return (
    <AppShell current="optical" subtitle="Рисунок на поверхности диска">
      <OpticalPanel />
    </AppShell>
  );
}
