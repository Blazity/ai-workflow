import { defineEventHandler, getQuery, sendRedirect, toWebRequest } from "h3";

import { auth } from "../../../../auth-instance.js";
import {
  acceptDashboardSsoInviteForUser,
  dashboardLoginUrl,
  dashboardSsoCompletionUrl,
  workerUrlFor,
} from "../../../../services/auth/index.js";
import { safeOAuthReturnPath } from "../../../../mcp/auth-pages.js";

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers });
  if (!session) {
    return sendRedirect(event, dashboardLoginUrl(), 302);
  }

  const inviteId = inviteIdFromQuery(getQuery(event).inviteId);
  if (inviteId) {
    await acceptDashboardSsoInviteForUser(auth, {
      inviteId,
      user: { id: session.user.id, email: session.user.email },
    });
  }

  const returnTo = safeOAuthReturnPath(getQuery(event).returnTo);
  if (returnTo) {
    return sendRedirect(event, workerUrlFor(returnTo), 302);
  }

  return sendRedirect(
    event,
    await dashboardSsoCompletionUrl(auth, session.session.token),
    302,
  );
});

function inviteIdFromQuery(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
