import type { Metadata } from "next";

import { DrivePage } from "@/addons/drives/drive-page";

export const metadata: Metadata = {
  title: "Полка дисков — Склад",
  description: "Какие диски на полке, что на них лежит и какой диск подключить.",
};

export default function DrivesRoute() {
  return <DrivePage />;
}
