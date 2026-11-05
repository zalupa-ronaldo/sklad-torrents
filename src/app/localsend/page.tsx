import { AppShell } from "@/components/app-shell";
import { LocalsendPanel } from "@/components/localsend-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "LocalSend — Склад",
  description: "Отправка файлов по локальной сети протоколом LocalSend, без прокси.",
};

export default function LocalsendPage() {
  return (
    <AppShell current="localsend" subtitle="Локальная сеть, порт 53317, без VLESS">
      <LocalsendPanel />
    </AppShell>
  );
}
