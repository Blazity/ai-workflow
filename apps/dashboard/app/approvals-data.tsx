import { getJSON, withQuery, authAwareFallback } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { ApprovalsScreen } from "@/components/cockpit/screens/approvals";
import type { ApprovalsResponse } from "@shared/contracts";

export async function ApprovalsData() {
  const [session, data] = await Promise.all([
    requireSession(),
    getJSON<ApprovalsResponse>(withQuery("/api/v1/approvals", { status: "all" })).catch((e) =>
      authAwareFallback(e, () => emptyApprovals()),
    ),
  ]);
  return <ApprovalsScreen approvals={data.approvals} canEdit={session.canEditWorkflows} />;
}

function emptyApprovals(): ApprovalsResponse {
  return { generatedAt: new Date().toISOString(), approvals: [] };
}
