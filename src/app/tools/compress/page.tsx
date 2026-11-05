import { Suspense } from "react";

import { CompressForm } from "@/app/tools/compress/form";

export default function CompressPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Загрузка…</p>}>
      <CompressForm />
    </Suspense>
  );
}
