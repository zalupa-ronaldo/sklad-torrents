import { Suspense } from "react";

import { MoveWizard } from "@/app/tools/move/wizard";

export default function MovePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Загрузка мастера…</p>}>
      <MoveWizard />
    </Suspense>
  );
}
