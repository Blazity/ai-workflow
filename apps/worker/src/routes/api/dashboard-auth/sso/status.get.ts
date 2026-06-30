import { eq } from "drizzle-orm";
import { defineEventHandler } from "h3";

import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";
import { getDb } from "../../../../db/client.js";
import { ssoProvider } from "../../../../db/schema.js";

export default defineEventHandler(async () => {
  const [provider] = await getDb()
    .select({ id: ssoProvider.id })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, DASHBOARD_SSO_PROVIDER_ID))
    .limit(1);

  return { enabled: Boolean(provider) };
});
