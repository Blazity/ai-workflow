// apps/dashboard/app/(cockpit)/evals/page.tsx — Arthur evals ("/evals")
import { Suspense } from "react";

import { EvalsData } from "@/app/evals-data";
import { EvalsSkeleton } from "@/app/evals-skeleton";

export default function EvalsPage() {
  return (
    <Suspense fallback={<EvalsSkeleton />}>
      <EvalsData />
    </Suspense>
  );
}
