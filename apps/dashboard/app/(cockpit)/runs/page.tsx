// apps/dashboard/app/(cockpit)/runs/page.tsx — Workflow runs ("/runs")
"use client";

import { RunsScreen } from "@/components/cockpit/screens/runs";
import { useCockpit } from "@/components/cockpit/context";

export default function RunsPage() {
  const { openRun } = useCockpit();
  return <RunsScreen onOpenRun={openRun} />;
}
