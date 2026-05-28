"use client";

// components/cockpit/screens/presandbox.tsx — pre-sandbox flow editor screen.
// Ported from variations/cockpit-flow.jsx (PreSandboxScreen).

import { FlowEditor } from "@/components/cockpit/screens/flow-editor";
import { PRESANDBOX_FLOW, PRESANDBOX_RUN_STATUS } from "@/lib/flows";

export function PreSandboxScreen() {
  return (
    <FlowEditor
      flow={PRESANDBOX_FLOW}
      runStatuses={PRESANDBOX_RUN_STATUS}
      title="Pre-sandbox steps"
      subtitle="Vercel workflow · wf_pr_review · steps that run before sandbox.execute"
    />
  );
}
