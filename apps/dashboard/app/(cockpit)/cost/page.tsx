// apps/dashboard/app/(cockpit)/cost/page.tsx — Cost & usage ("/cost")
import { Suspense } from "react";
import { CostData } from "@/app/cost-data";
import { CostSkeleton } from "@/app/cost-skeleton";

export default function CostPage() {
  return (
    <Suspense fallback={<CostSkeleton />}>
      <CostData />
    </Suspense>
  );
}
