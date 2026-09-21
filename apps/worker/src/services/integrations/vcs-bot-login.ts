import type { VcsProviderKind } from "@shared/contracts";
import {
  getConfiguredVcsProviders,
  getVcsBotLoginConfig,
} from "../../infra/vcs-config.js";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";
import { resolveUsableIntegrations } from "./usable.js";

/** Resolve the configured automation account used to suppress recursive triggers. */
export async function getVcsBotLogin(kind: VcsProviderKind): Promise<string | undefined> {
  const configured = getVcsBotLoginConfig();
  const configuredProviders: string[] = getConfiguredVcsProviders().map(
    (provider) => provider.kind,
  );
  const byProvider: Record<string, string | undefined> = {
    ...configured.byProvider,
  };
  const legacyByProvider: Record<string, string | undefined> = {};
  const resolved = await resolveUsableIntegrations({
    signal: AbortSignal.timeout(30_000),
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  });
  if (resolved.readable) {
    for (const integration of resolved.usable) {
      const provider = integration.manifest.id;
      const state = resolved.states.get(provider);
      configuredProviders.push(provider);
      if (state?.configuredFields?.includes("botLogin")) {
        byProvider[provider] = integration.ctx.connection.botLogin;
      }
      if (state?.configuredFields?.includes("legacyBotLogin")) {
        legacyByProvider[provider] = integration.ctx.connection.legacyBotLogin;
      }
    }
  }
  const activeProviders = [...new Set(configuredProviders)];
  return resolveVcsBotLogin(
    kind,
    activeProviders,
    { byProvider, legacy: legacyByProvider[kind] ?? configured.legacy },
  );
}
