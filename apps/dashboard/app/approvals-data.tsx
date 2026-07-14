import { getJSON, withQuery, authAwareFallback } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { ApprovalsScreen } from "@/components/cockpit/screens/approvals";
import type { ApprovalRequest, ApprovalsResponse } from "@shared/contracts";

export async function ApprovalsData() {
  const [session, result] = await Promise.all([requireSession(), fetchApprovals()]);
  return (
    <ApprovalsScreen
      approvals={result.approvals}
      error={result.error}
      canEdit={session.canEditWorkflows}
    />
  );
}

/**
 * A failed fetch must stay visibly distinct from a genuine "zero approvals"
 * response, so a worker/network failure carries an `error` message through
 * instead of collapsing to the same empty array a real empty result produces.
 */
async function fetchApprovals(): Promise<{ approvals: ApprovalRequest[]; error: string | null }> {
  try {
    const data = await getJSON<ApprovalsResponse>(withQuery("/api/v1/approvals", { status: "all" }));
    return { approvals: data.approvals, error: null };
  } catch (e) {
    return authAwareFallback(e, () => ({
      approvals: [],
      error: "Couldn't load approvals. The worker may be unreachable.",
    }));
  }
}
