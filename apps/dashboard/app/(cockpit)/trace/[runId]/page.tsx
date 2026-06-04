// apps/dashboard/app/(cockpit)/trace/[runId]/page.tsx — Run trace ("/trace/<runId>")
import { Suspense } from "react";

import { TraceData } from "@/app/trace-data";
import { TraceSkeleton } from "@/app/trace-skeleton";

export default async function TracePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <Suspense fallback={<TraceSkeleton />}>
      <TraceData runId={runId} />
    </Suspense>
  );
}
