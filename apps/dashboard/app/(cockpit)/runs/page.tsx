// apps/dashboard/app/(cockpit)/runs/page.tsx — Workflow runs ("/runs")
import { Suspense } from "react";

import { RunsData } from "@/app/runs-data";
import { RunsSkeleton } from "@/app/runs-skeleton";

export default function RunsPage() {
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsData />
    </Suspense>
  );
}
