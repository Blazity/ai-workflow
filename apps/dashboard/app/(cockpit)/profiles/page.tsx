import { Suspense } from "react";
import { HarnessProfilesData } from "@/app/harness-profiles-data";
import { HarnessProfilesSkeleton } from "@/app/harness-profiles-skeleton";

export default function HarnessProfilesPage() {
  return (
    <Suspense fallback={<HarnessProfilesSkeleton />}>
      <HarnessProfilesData />
    </Suspense>
  );
}
