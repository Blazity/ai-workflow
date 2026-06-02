// apps/dashboard/app/page.tsx
import { Suspense } from "react";

import { CockpitApp } from "./cockpit-app";
import { OverviewData } from "./overview-data";
import { OverviewSkeleton } from "./overview-skeleton";

export default function Page() {
  return (
    <CockpitApp
      overviewSlot={
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewData />
        </Suspense>
      }
    />
  );
}
