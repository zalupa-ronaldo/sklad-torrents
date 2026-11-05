import type { Metadata } from "next";

import { ToolsShell } from "@/app/tools/shell";

export const metadata: Metadata = {
  title: "Медиа и игры — Склад",
  description: "HandBrake, перенос игр и сжатие NTFS на Mac и Windows.",
};

export default function ToolsLayout({ children }: LayoutProps<"/tools">) {
  return <ToolsShell>{children}</ToolsShell>;
}
