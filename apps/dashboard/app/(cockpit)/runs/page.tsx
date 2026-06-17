// apps/dashboard/app/(cockpit)/runs/page.tsx — Workflow runs ("/runs")
import { Suspense } from "react";

import { RunsData } from "@/app/runs-data";
import { RunsSkeleton } from "@/app/runs-skeleton";
import { parseWindow } from "@/lib/window";

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const window = parseWindow(sp.window);
  const q = typeof sp.q === "string" ? sp.q : "";
  // Key on the window only: a window switch is a deliberate, larger refetch
  // (show the skeleton); `q` changes re-render in place so the search input
  // keeps focus while typing.
  return (
    <Suspense key={window} fallback={<RunsSkeleton />}>
      <RunsData window={window} q={q} />
    </Suspense>
  );
}
