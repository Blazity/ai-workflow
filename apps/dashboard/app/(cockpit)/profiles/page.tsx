import { Suspense } from "react";
import { notFound } from "next/navigation";

import { HarnessProfilesData } from "@/app/harness-profiles-data";
import { HarnessProfilesSkeleton } from "@/app/harness-profiles-skeleton";
import { harnessProfileAuthoringEnabled } from "@/lib/harness-profiles/rollout";

export default function HarnessProfilesPage() {
  if (!harnessProfileAuthoringEnabled) notFound();
  return (
    <Suspense fallback={<HarnessProfilesSkeleton />}>
      <HarnessProfilesData />
    </Suspense>
  );
}
