import { defineEventHandler } from "h3";

import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";
import { isDashboardSsoProviderRegistered } from "../../../../services/auth/index.js";

export default defineEventHandler(async () => {
  return { enabled: await isDashboardSsoProviderRegistered(DASHBOARD_SSO_PROVIDER_ID) };
});
