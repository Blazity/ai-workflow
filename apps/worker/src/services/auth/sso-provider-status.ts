/**
 * Whether single sign-on is wired up, as the login screen asks it.
 *
 * A row, not a setting: the provider is registered in the database by an
 * operator, so the honest answer comes from there rather than from whether the
 * deployment happens to carry SSO credentials.
 */
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { ssoProvider } from "../../db/schema.js";

export async function isDashboardSsoProviderRegistered(
  providerId: string,
): Promise<boolean> {
  const [provider] = await getDb()
    .select({ id: ssoProvider.id })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);
  return Boolean(provider);
}
