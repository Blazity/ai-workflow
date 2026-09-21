import type { VcsProviderKind } from "@shared/contracts";
import { resolveVcsBotLogin } from "../../adapters/vcs/vcs-bot-identity.js";
import { resolveUsableIntegrations } from "./usable.js";

/**
 * The automation account whose own comments and pushes must not start a run.
 *
 * Every version control provider is an integration since S11, so the answer is
 * one read of what is connected: the provider's own `botLogin`, or the legacy
 * single-provider `legacyBotLogin` when this deployment has exactly one. The
 * environment is not read here; a connection sourced from it already reaches
 * this through the resolver, and a second read would disagree with the first
 * the moment an admin stored values in the dashboard instead.
 */
export async function getVcsBotLogin(kind: VcsProviderKind): Promise<string | undefined> {
  const reading = await readVcsBotLogin(kind);
  return reading.readable ? reading.login : undefined;
}

/**
 * The same answer, with "could not be read" kept apart from "none is set".
 *
 * A caller that ACTS on the answer needs the difference. Not knowing the
 * automation account means every comment and push it made reads as somebody
 * else's, so the workflow answers its own review and starts a run off its own
 * push. A caller that only decorates a record can keep taking `undefined`.
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
    signal: AbortSignal.timeout(30_000),
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  });
  if (!resolved.readable) return { readable: false, reason: resolved.reason };
  for (const integration of resolved.usable) {
    const provider = integration.manifest.id;
    const state = resolved.states.get(provider);
    providers.push(provider);
    if (state?.configuredFields?.includes("botLogin")) {
      byProvider[provider] = integration.ctx.connection.botLogin;
    }
    if (state?.configuredFields?.includes("legacyBotLogin")) {
      legacyByProvider[provider] = integration.ctx.connection.legacyBotLogin;
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
