import { defineEventHandler, getQuery, sendRedirect, toWebRequest } from "h3";

import { env } from "../../../../../env.js";
import { auth } from "../../../../auth-instance.js";
import { getDb } from "../../../../db/client.js";
import { acceptDashboardSsoInvite } from "../../../../lib/auth/invite-acceptance.js";
import { createDashboardSsoHandoff } from "../../../../lib/auth/sso-handoff.js";

export default defineEventHandler(async (event) => {
  const dashboardOrigin = env.DASHBOARD_ORIGIN.replace(/\/$/, "");
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers });
  if (!session) {
    return sendRedirect(event, `${dashboardOrigin}/login`, 302);
  }

  const inviteId = inviteIdFromQuery(getQuery(event).inviteId);
  if (inviteId) {
    await acceptDashboardSsoInvite(getDb(), auth, {
      organizationSlug: env.DASHBOARD_ORG_SLUG,
      inviteId,
      user: { id: session.user.id, email: session.user.email },
    });
  }

  const handoffToken = await createDashboardSsoHandoff(auth, session.session.token);
  const redirectUrl = new URL("/api/auth/sso/complete", dashboardOrigin);
  redirectUrl.searchParams.set("token", handoffToken);
  return sendRedirect(event, redirectUrl.href, 302);
});

function inviteIdFromQuery(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
