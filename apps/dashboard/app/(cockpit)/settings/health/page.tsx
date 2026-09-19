import { Suspense } from "react";
import { HealthData } from "@/app/health-data";
import { HealthSkeleton } from "@/app/health-skeleton";

export default function HealthPage() {
  return (
    <Suspense fallback={<HealthSkeleton />}>
      <HealthData />
    </Suspense>
  );
}
