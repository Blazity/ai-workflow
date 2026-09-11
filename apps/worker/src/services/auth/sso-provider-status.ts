/**
 * Whether single sign-on is wired up, as the login screen asks it.
 *
 * A row, not a setting: the provider is registered in the database by an
 * operator, so the honest answer comes from there rather than from whether the
 * deployment happens to carry SSO credentials.
 */
import { isConnectedSsoProviderRegistered } from "../../db/repositories/auth.js";

export async function isDashboardSsoProviderRegistered(
  providerId: string,
): Promise<boolean> {
  return isConnectedSsoProviderRegistered(providerId);
}
