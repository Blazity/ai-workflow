import type { VcsProviderKind } from "@shared/contracts";

export interface VcsBotLoginConfig {
  github?: string;
  gitlab?: string;
  legacy?: string;
}

export function resolveVcsBotLogin(
  kind: VcsProviderKind,
  configuredProviders: readonly VcsProviderKind[],
  logins: VcsBotLoginConfig,
): string | undefined {
  const providerSpecific = kind === "github" ? logins.github : logins.gitlab;
  if (providerSpecific) return providerSpecific;
  return configuredProviders.length === 1 && configuredProviders[0] === kind
    ? logins.legacy
    : undefined;
}
