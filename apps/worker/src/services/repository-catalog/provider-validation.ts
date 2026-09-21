import { integrationsProviding } from "@integrations/registry";
import { DashboardAuthError } from "@shared/contracts";

/**
 * Refuse a repository whose provider this build cannot serve, before anything
 * is persisted.
 *
 * The registry is the whole answer. Until S11 there was also a hard-coded map
 * of the providers core shipped itself, which is exactly the branch a third
 * provider would have had to be added to; the list is now whatever integrations
 * declare the `vcs` capability.
 */
export function assertVcsProviderAvailable(provider: string, action: string): void {
  const integrations = integrationsProviding("vcs");
  if (integrations.some((manifest) => manifest.id === provider)) return;
  const supported = new Intl.ListFormat("en", { type: "conjunction" }).format(
    integrations.map((manifest) => manifest.name),
  );
  throw new DashboardAuthError(
    400,
    integrations.length === 0
      ? `Cannot ${action} provider "${provider}": this deployment has no version control integration connected.`
      : `Cannot ${action} provider "${provider}": this build can import repositories from ${supported}.`,
  );
}
