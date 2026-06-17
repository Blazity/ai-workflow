// apps/dashboard/app/(cockpit)/cost/page.tsx — Cost & usage ("/cost")
import { Suspense } from "react";
import { CostData } from "@/app/cost-data";
import { CostSkeleton } from "@/app/cost-skeleton";
import { parseWindow } from "@/lib/window";

export default async function CostPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const window = parseWindow((await searchParams).window);
  return (
    <Suspense key={window} fallback={<CostSkeleton />}>
      <CostData window={window} />
    </Suspense>
  );
}
