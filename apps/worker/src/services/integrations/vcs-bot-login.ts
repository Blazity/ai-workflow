import { VCS_BOT_LOGIN_FIELD, VCS_LEGACY_BOT_LOGIN_FIELD } from "@integrations/sdk";
import type { VcsProviderKind } from "@shared/contracts";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";
import { resolveUsableIntegrations } from "./usable.js";

/**
 * The automation account whose own comments and pushes must not start a run.
 *
 * Every version control provider is an integration since S11, so the answer is
 * one read of what is connected: the provider's own login field, or the legacy
 * single-provider one when this deployment has exactly one (`VCS_BOT_LOGIN_FIELD`
 * and `VCS_LEGACY_BOT_LOGIN_FIELD` in the SDK). The
 * environment is not read here; a connection sourced from it already reaches
 * this through the resolver, and a second read would disagree with the first
 * the moment an admin stored values in the dashboard instead.
 *
 * "Could not be read" is kept apart from "none is set", and there is no reader
 * that folds the two: every caller acts on the answer. Not knowing the
 * automation account means every comment and push it made reads as somebody
 * else's, so the workflow answers its own review and starts a run off its own
 * push.
 */
export async function readVcsBotLogin(
  kind: VcsProviderKind,
): Promise<
  { readable: true; login: string | undefined } | { readable: false; reason: string }
> {
  const byProvider: Record<string, string | undefined> = {};
  const legacyByProvider: Record<string, string | undefined> = {};
  const providers: string[] = [];
  const resolved = await resolveUsableIntegrations({
    lifetime: AbortSignal.timeout(30_000),
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  });
  if (!resolved.readable) return { readable: false, reason: resolved.reason };
  for (const integration of resolved.usable) {
    const provider = integration.manifest.id;
    const state = resolved.states.get(provider);
    providers.push(provider);
    if (state?.configuredFields?.includes(VCS_BOT_LOGIN_FIELD)) {
      byProvider[provider] = integration.ctx.connection[VCS_BOT_LOGIN_FIELD];
    }
    if (state?.configuredFields?.includes(VCS_LEGACY_BOT_LOGIN_FIELD.key)) {
      legacyByProvider[provider] = integration.ctx.connection[VCS_LEGACY_BOT_LOGIN_FIELD.key];
    }
  }
  return {
    readable: true,
    login: resolveVcsBotLogin(kind, providers, {
      byProvider,
      legacy: legacyByProvider[kind],
    }),
  };
}
