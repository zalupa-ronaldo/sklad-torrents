import { Suspense } from "react";

import { TranscodeForm } from "@/app/tools/transcode/form";

export default function TranscodePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Загрузка формы…</p>}>
      <TranscodeForm />
    </Suspense>
  );
}
