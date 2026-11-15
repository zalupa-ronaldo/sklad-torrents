import { AppShell } from "@/components/app-shell";
import { LocalsendPanel } from "@/components/localsend-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "LocalSend — Склад",
  description: "Отправка файла или папки с Mac или ПК на устройство LocalSend и приём, с прогрессом и SHA-256.",
};

export default function LocalsendPage() {
  return (
    <AppShell current="localsend" subtitle="Файл или папка с Mac или ПК, приём, прогресс и SHA-256">
      <LocalsendPanel />
    </AppShell>
  );
}
