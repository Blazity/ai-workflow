import { integrationsProviding } from "@integrations/registry";
import { DashboardAuthError } from "@shared/contracts";

/**
 * Refuse a repository whose provider this build does not ship, before anything
 * is persisted.
 *
 * The registry is the whole answer. Until S11 there was also a hard-coded map
 * of the providers core shipped itself, which is exactly the branch a third
 * provider would have had to be added to; the list is now whatever integrations
 * declare the `vcs` capability.
 *
 * About the BUILD, not the connection: a provider that ships but is not
 * connected passes here and is refused where the repository is used. The
 * sentences say so, because "not connected" sent an admin to the Integrations
 * page for something only a rebuild can change.
 */
export function assertVcsProviderShipped(provider: string, action: string): void {
  const integrations = integrationsProviding("vcs");
  if (integrations.some((manifest) => manifest.id === provider)) return;
  const supported = new Intl.ListFormat("en", { type: "conjunction" }).format(
    integrations.map((manifest) => manifest.name),
  );
  throw new DashboardAuthError(
    400,
    integrations.length === 0
      ? `Cannot ${action} provider "${provider}": this build ships no version control integration.`
      : `Cannot ${action} provider "${provider}": this build can import repositories from ${supported}.`,
  );
}
