/**
 * How a block that asked for a capability reaches one.
 *
 * A block declares `requires.capabilities` rather than a provider, so this is
 * where core hands it exactly what it declared and nothing else: a capability
 * absent from the manifest is absent from the object, which is also what the
 * SDK's types say.
 *
 * Today every ported capability is served by core's own adapters, built from
 * the deployment's variables (`engine/support/adapters.ts`). That is decision
 * 10 of the plan: an implementation that needs core storage or core
 * configuration stays in core and is registered as the built-in provider.
 * Stages S8 to S13 replace each built-in with an integration, and only this
 * function changes when they do: the blocks that asked for the capability do
 * not.
 */
import type { IntegrationCapabilityAccess, VcsRepositoryRef } from "@integrations/sdk";
import { repositoryCatalogProviderSchema, type VcsProviderKind } from "@shared/contracts";
import { env } from "../../infra/vcs-config.js";
import type { LlmProvider } from "../../infra/llm-provider.js";
import { createAdapters } from "./adapters.js";

/** Exactly the capabilities a block declared, each as the SDK types it. */
export function integrationCapabilityAccess(
  capabilities: readonly string[],
): Partial<IntegrationCapabilityAccess> {
  const access: Partial<IntegrationCapabilityAccess> = {};
  // One bundle for the whole call. Each one opens a run registry connection, so
  // a block asking for two capabilities used to get two.
  const adapters =
    capabilities.includes("issue_tracker") || capabilities.includes("messaging")
      ? createAdapters()
      : null;
  for (const capability of capabilities) {
    if (capability === "issue_tracker" && adapters) {
      access.issue_tracker = adapters.issueTracker;
      continue;
    }
    if (capability === "messaging" && adapters) {
      access.messaging = adapters.messaging;
      continue;
    }
    if (capability === "vcs") {
      // Many providers at once, chosen per repository, so this one is a lookup
      // rather than an adapter: the caller names the repository it is working
      // on and core builds the adapter for that repository's provider.
      access.vcs = (repository: VcsRepositoryRef) =>
        createAdapters({
          provider: vcsProviderOf(repository.provider),
          repoPath: repository.repoPath,
          baseBranch: repository.baseBranch,
        }).vcs;
    }
  }
  return access;
}

/**
 * The provider a repository names, as core's own catalog spells it.
 *
 * Refused by name rather than cast: an integration that passes something core
 * has never heard of would otherwise reach the adapter factory and fail there,
 * with a message about a repository rather than about the value it was handed.
 * The set grows as S10 and S11 move each provider into its own integration.
 */
function vcsProviderOf(provider: string): VcsProviderKind {
  // The catalog's own schema, so what a block may name is exactly what a
  // repository record may carry. Naming the values here would be core naming a
  // provider, which the core-reference gate refuses.
  const parsed = repositoryCatalogProviderSchema.safeParse(provider);
  if (!parsed.success) {
    throw new Error(
      `This deployment has no version control provider called "${provider}", so the block cannot be given one.`,
    );
  }
  return parsed.data;
}

/**
 * The model a block reaches through `ctx.llm`, chosen and paid for by core.
 *
 * Bounded by `infra/llm.ts`, which keeps a call under the plain function's
 * 300 s invocation ceiling. A block that makes several calls shares that
 * budget, so a late call gets less time rather than the invocation being
 * killed with the work half done.
 */
export function integrationLlm(defaults: {
  readonly provider: "claude" | "codex";
  readonly model: string;
}) {
  return {
    async generateObject(request: {
      system?: string;
      prompt: string;
      schema: { parse(value: unknown): unknown };
      timeoutMs?: number;
    }): Promise<unknown> {
      const { generateProviderText } = await import("../../infra/llm.js");
      // The AI SDK reads a zod schema directly, which keeps this working under
      // both zod versions this repository builds against: production runs zod 4
      // and the tests run zod 3, and only one of them has `z.toJSONSchema`.
      const { zodSchema } = await import("ai");
      const result = await generateProviderText({
        model: defaults.model,
        provider: defaults.provider as LlmProvider,
        prompt: request.prompt,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        schema: zodSchema(request.schema as never).jsonSchema,
        credentials: {
          ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
          ...(env.CODEX_API_KEY ? { codexApiKey: env.CODEX_API_KEY } : {}),
        },
      });
      // Parsed with the block's own schema rather than trusted: the SDK
      // promises the block output the schema accepted, and a model that
      // answered something else is a rejection, not a value to pass on.
      return request.schema.parse(result.object);
    },
  };
}
