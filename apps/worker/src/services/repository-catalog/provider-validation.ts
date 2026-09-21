import { integrationsProviding } from "@integrations/registry";
import { DashboardAuthError } from "@shared/contracts";

/** Provider ids still shipped by core. S11 removes this with the GitHub move. */
const CORE_VCS_PROVIDERS = new Map([["github", "GitHub"]]);

/** Refuse a provider before persistence. */
export function assertVcsProviderAvailable(provider: string, action: string): void {
  const integrations = integrationsProviding("vcs");
  const registered = integrations.some((manifest) => manifest.id === provider);
  const builtin = CORE_VCS_PROVIDERS.has(provider);
  if (registered || builtin) return;
  const supported = new Intl.ListFormat("en", { type: "conjunction" }).format([
    ...CORE_VCS_PROVIDERS.values(),
    ...integrations.map((manifest) => manifest.name),
  ]);
  throw new DashboardAuthError(
    400,
    `Cannot ${action} provider "${provider}": this build can import repositories from ${supported}.`,
  );
}
