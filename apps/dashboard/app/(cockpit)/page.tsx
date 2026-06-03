// apps/dashboard/app/(cockpit)/page.tsx — Overview ("/")
import { Suspense } from "react";

import { OverviewData } from "@/app/overview-data";
import { OverviewSkeleton } from "@/app/overview-skeleton";

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewData />
    </Suspense>
  );
}
