"use client";

// components/cockpit/screens/postpr.tsx — post-PR-review flow editor screen.
// Ported from variations/cockpit-flow.jsx (PostPRReviewScreen).

import { FlowEditor } from "@/components/cockpit/screens/flow-editor";
import { POSTPR_FLOW, POSTPR_RUN_STATUS } from "@/lib/flows";

export function PostPRReviewScreen() {
  return (
    <FlowEditor
      flow={POSTPR_FLOW}
      runStatuses={POSTPR_RUN_STATUS}
      title="Post-PR review steps"
      subtitle="Triggered after the agent opens a PR · drives GitHub checks"
    />
  );
}
