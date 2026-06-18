// apps/dashboard/app/(cockpit)/page.tsx — Overview ("/")
import { Suspense } from "react";

import { OverviewData } from "@/app/overview-data";
import { OverviewSkeleton } from "@/app/overview-skeleton";
import { parseWindow } from "@/lib/window";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const window = parseWindow((await searchParams).window);
  return (
    <Suspense key={window} fallback={<OverviewSkeleton />}>
      <OverviewData window={window} />
    </Suspense>
  );
}
