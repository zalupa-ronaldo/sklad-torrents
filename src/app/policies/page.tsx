import { PoliciesScreen } from "@/components/policies-screen";

export const metadata = {
  title: "Правила раскладки — Склад",
  description: "Куда класть раздачи по типу. Автоматика выключена, пока не посмотрите сухой прогон.",
};

export default function PoliciesPage() {
  return <PoliciesScreen />;
}
