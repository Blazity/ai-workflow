import { defineEventHandler, sendRedirect, toWebRequest } from "h3";

import { env } from "../../../../../env.js";
import { auth } from "../../../../auth-instance.js";
import { createDashboardSsoHandoff } from "../../../../lib/auth/sso-handoff.js";

export default defineEventHandler(async (event) => {
  const dashboardOrigin = env.DASHBOARD_ORIGIN.replace(/\/$/, "");
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers });
  if (!session) {
    return sendRedirect(event, `${dashboardOrigin}/login`, 302);
  }

  const handoffToken = await createDashboardSsoHandoff(auth, session.session.token);
  const redirectUrl = new URL("/api/auth/sso/complete", dashboardOrigin);
  redirectUrl.searchParams.set("token", handoffToken);
  return sendRedirect(event, redirectUrl.href, 302);
});
