import { integrationManifest } from "@integrations/registry";
import type {
  IntegrationContext,
  IntegrationManifest,
  VCSAdapter,
  VcsIntegrationAdapter,
  VcsSandboxCredentials,
} from "@integrations/sdk";
import type { IntegrationConnectionPin } from "@shared/contracts";
import {
  env,
  getConfiguredVcsProviders,
  getVcsProviderConfig,
  type VcsProviderKind,
} from "../../infra/vcs-config.js";
import {
  hasManualDispatchPrCapability,
  type ManualDispatchPrCapableVCS,
} from "../../adapters/vcs/types.js";
import type { SandboxProviderConfig } from "../../sandbox/manager.js";
import { createVCSForRepository } from "../../adapters/vcs/create-vcs.js";
import { getBotIdentity, getVcsToken } from "../../adapters/vcs/github-auth.js";

/**
 * The connections a run started with, as far as this caller knows them.
 *
 * Absent is not "this run pinned nothing". It means nobody recorded pins for
 * this call, and there are exactly two ways to get there:
 *
 * - **The caller is not a run.** Parsing a pull request URL for a manual
 *   dispatch, listing a provider's repositories for the catalog: no run
 *   started, so there is no moment to be pinned to and current settings are
 *   the right ones to use.
 * - **The run's row predates the pins column.** Migration
 *   `0073_run_integration_pins` added `workflow_runs.integration_pins` as
 *   nullable, so every row written before that deploy carries NULL and its
 *   pins can never be recovered. Such a run proceeds against the provider as
 *   it is configured now, with nothing to compare.
 *
 * The second case is defensible only because this branch merges after a total
 * drain (zero running, awaiting or parked runs on production and demo: see
 * "Corrected S10 drain" in `docs/plans/2026-09-18-integrations.md`), so no run
 * without pins can still be alive to reach this code. It is not defensible on
 * its own, and it is not silent: the reconciler, the one caller that reaches a
 * run row directly rather than being handed pins by a step, logs
 * `pr_check_reconcile_without_integration_pins` before it proceeds
 * (`engine/runtime/pr-external-resources.ts`). If that line ever appears after
 * the drain, the drain did not hold.
 */
export type RunIntegrationPins = readonly IntegrationConnectionPin[] | undefined;

/**
 * Whether this call carries pins worth comparing against current settings.
 *
 * An empty list answers no for the same reason an absent one does: there is
 * nothing in it to find this provider in, so there is no recorded connection
 * to hold the run to. See {@link RunIntegrationPins} for who arrives without
 * them.
 */
export function hasRecordedIntegrationPins(
  pins: RunIntegrationPins,
): pins is readonly IntegrationConnectionPin[] {
  return pins !== undefined && pins.length > 0;
}

export interface RepositoryVcsTarget {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
  integrationPins?: RunIntegrationPins;
}

export interface RepositoryVcsRuntime {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
  vcs: VCSAdapter;
  credentials: () => Promise<VcsSandboxCredentials>;
}

const VCS_TIMEOUT_MS = 30_000;

async function resolveIntegrationAdapter(target: RepositoryVcsTarget): Promise<VCSAdapter> {
  const manifest = integrationManifest(target.provider);
  if (!manifest?.capabilities.includes("vcs")) {
    const config = getVcsProviderConfig(target.provider);
    return createVCSForRepository(config, target);
  }

  const { resolveUsableIntegrations, checkIntegrationPin } = await import(
    "../../services/integrations/runtime.js"
  );
  const resolved = await resolveUsableIntegrations({
    signal: AbortSignal.timeout(VCS_TIMEOUT_MS),
    filter: (candidate) => candidate.id === target.provider,
  });
  if (!resolved.readable) {
    throw new Error(
      `Version control provider ${target.provider} could not read its integration settings: ${resolved.reason}`,
    );
  }
  const usable = resolved.usable[0];
  const state = resolved.states.get(target.provider);
  if (!usable || !state) {
    throw new Error(
      `Version control provider ${target.provider} is not connected. Connect it on the Integrations page.`,
    );
  }
  // No pins means nothing to hold this call to, so it proceeds against the
  // provider as it is configured right now. That is correct for a caller that
  // is not a run, and covered by the S10 drain for a run row written before the
  // pins column existed. {@link RunIntegrationPins} names both and says who
  // says so out loud.
  if (hasRecordedIntegrationPins(target.integrationPins)) {
    const pin = target.integrationPins.find(
      (candidate) => candidate.integrationId === target.provider,
    );
    const check = pin
      ? checkIntegrationPin(pin, state)
      : ({ ok: false, reason: "disconnected" } as const);
    if (!check.ok) {
      throw new Error(
        `Version control provider ${usable.manifest.name} moved after this run started (${check.reason}). Start a new run.`,
      );
    }
  }
  const factory = usable.runtime.capabilities.vcs;
  if (typeof factory !== "function") {
    throw new TypeError(`${usable.manifest.name} declares version control and ships no adapter.`);
  }

  const { getVcsBotLogin } = await import("../../services/integrations/runtime.js");
  const { legacyBotLogin: _legacyBotLogin, ...connectionWithoutLegacyBot } = usable.ctx.connection;
  const ctx = {
    ...usable.ctx,
    connection: {
      ...connectionWithoutLegacyBot,
      botLogin: await getVcsBotLogin(target.provider),
    },
  } as unknown as IntegrationContext<IntegrationManifest>;
  return (factory as unknown as (
    context: IntegrationContext<IntegrationManifest>,
    repository: { repoPath: string; baseBranch: string },
  ) => VCSAdapter)(ctx, target);
}

function lazyAdapter(resolve: () => Promise<VCSAdapter>): VCSAdapter {
  let resolved: Promise<VCSAdapter> | undefined;
  const adapter = () => (resolved ??= resolve());
  return new Proxy({} as VCSAdapter, {
    get(_target, property) {
      if (property === "then") return;
      if (property === "botLogin") return;
      return async (...args: unknown[]) => {
        const concrete = await adapter();
        const member = (concrete as unknown as Record<PropertyKey, unknown>)[property];
        if (typeof member !== "function") {
          throw new TypeError(`Version control provider does not support ${String(property)}.`);
        }
        return member.apply(concrete, args);
      };
    },
  });
}

export function createRepositoryVcsRuntime(target: RepositoryVcsTarget): RepositoryVcsRuntime {
  let concrete: Promise<VCSAdapter> | undefined;
  const resolve = () => (concrete ??= resolveIntegrationAdapter(target));
  return {
    provider: target.provider,
    repoPath: target.repoPath,
    baseBranch: target.baseBranch,
    vcs: lazyAdapter(resolve),
    credentials: async () => {
      const adapter = await resolve() as VcsIntegrationAdapter;
      if (adapter.sandboxCredentials) return adapter.sandboxCredentials();
      const config = getVcsProviderConfig(target.provider);
      const identity = await resolveCommitIdentity(config);
      return {
        host: config.host,
        authUser: "x-access-token",
        token: await getVcsToken(config),
        commitAuthor: identity.name,
        commitEmail: identity.email,
      };
    },
  };
}

export function createRepositoryVCS(target: RepositoryVcsTarget): VCSAdapter {
  return createRepositoryVcsRuntime(target).vcs;
}

export async function loadRepositoryVcsProfile(target: RepositoryVcsTarget) {
  const manifest = integrationManifest(target.provider);
  if (!manifest?.capabilities.includes("vcs")) {
    const { createRepositoryProfileSource } = await import(
      "../../adapters/vcs/create-vcs.js"
    );
    return createRepositoryProfileSource(
      getVcsProviderConfig(target.provider),
      target.repoPath,
    ).loadProfile();
  }
  const adapter = await resolveIntegrationAdapter(target) as VcsIntegrationAdapter;
  if (!adapter.loadRepositoryProfile) {
    throw new Error(
      `Version control provider ${target.provider} does not support repository profiles.`,
    );
  }
  return adapter.loadRepositoryProfile(target.repoPath);
}

export function createManualDispatchPrReader(target: {
  provider: VcsProviderKind;
  repoPath: string;
}): ManualDispatchPrCapableVCS {
  const vcs = createRepositoryVCS({ ...target, baseBranch: "" });
  if (!hasManualDispatchPrCapability(vcs)) {
    throw new Error(`VCS provider ${target.provider} cannot read pull requests`);
  }
  return vcs;
}

export async function resolveConfiguredPullRequestUrl(
  url: URL,
): Promise<{ provider: string; repoPath: string; prNumber: number } | null> {
  const providerIds = new Set<string>(
    getConfiguredVcsProviders().map((provider) => provider.kind),
  );
  const { usableIntegrations } = await import("../../services/integrations/runtime.js");
  for (const entry of await usableIntegrations({
    signal: AbortSignal.timeout(VCS_TIMEOUT_MS),
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  })) providerIds.add(entry.manifest.id);

  for (const provider of providerIds) {
    const adapter = await resolveIntegrationAdapter({ provider, repoPath: "", baseBranch: "" });
    const parse = (adapter as VcsIntegrationAdapter).parsePullRequestUrl;
    if (!parse) continue;
    const parsed = parse.call(adapter, url);
    if (parsed) return { provider, ...parsed };
  }
  return null;
}

export async function buildSandboxProviderConfigs(
  neededProviders?: Iterable<VcsProviderKind>,
  integrationPins?: readonly IntegrationConnectionPin[],
): Promise<SandboxProviderConfig[]> {
  const { logger } = await import("../../infra/logger.js");
  const needed = neededProviders ? new Set(neededProviders) : null;
  const providerIds = new Set<string>();
  for (const provider of getConfiguredVcsProviders()) providerIds.add(provider.kind);
  const { usableIntegrations } = await import("../../services/integrations/runtime.js");
  for (const entry of await usableIntegrations({
    signal: AbortSignal.timeout(VCS_TIMEOUT_MS),
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  })) providerIds.add(entry.manifest.id);

  const configs: SandboxProviderConfig[] = [];
  for (const provider of providerIds) {
    if (needed && !needed.has(provider)) continue;
    try {
      const credentials = await createRepositoryVcsRuntime({
        provider,
        repoPath: "",
        baseBranch: "",
        integrationPins,
      }).credentials();
      configs.push({
        kind: provider,
        host: credentials.host,
        authUser: credentials.authUser,
        getToken: async () => (await createRepositoryVcsRuntime({
          provider,
          repoPath: "",
          baseBranch: "",
          integrationPins,
        }).credentials()).token,
        commitAuthor: credentials.commitAuthor,
        commitEmail: credentials.commitEmail,
      });
    } catch (err) {
      logger.warn(
        { provider, err: err instanceof Error ? err.message : String(err) },
        "sandbox_provider_identity_resolution_failed",
      );
    }
  }
  return configs;
}

export async function listIntegrationVcsRepositories(options: {
  neededProviders?: Iterable<string>;
  integrationPins?: readonly IntegrationConnectionPin[];
} = {}): Promise<{
  repositories: import("@integrations/sdk").VcsRepositoryMetadata[];
  providers: string[];
  failures: Array<{ provider: string; message: string; error: unknown }>;
}> {
  const { resolveUsableIntegrations, checkIntegrationPin } = await import(
    "../../services/integrations/runtime.js"
  );
  const needed = options.neededProviders ? new Set(options.neededProviders) : null;
  const resolved = await resolveUsableIntegrations({
    signal: AbortSignal.timeout(VCS_TIMEOUT_MS),
    filter: (manifest) =>
      manifest.capabilities.includes("vcs") && (!needed || needed.has(manifest.id)),
  });
  if (!resolved.readable) {
    return {
      repositories: [],
      providers: [],
      failures: [
        { provider: "integrations", message: resolved.reason, error: new Error(resolved.reason) },
      ],
    };
  }
  const usable = resolved.usable;
  const repositories: import("@integrations/sdk").VcsRepositoryMetadata[] = [];
  const failures: Array<{ provider: string; message: string; error: unknown }> = [];
  for (const entry of usable) {
    try {
      const pin = options.integrationPins?.find(
        (candidate) => candidate.integrationId === entry.manifest.id,
      );
      // See the skip in `resolveIntegrationAdapter`: same rule, same reasons.
      if (hasRecordedIntegrationPins(options.integrationPins)) {
        const state = resolved.states.get(entry.manifest.id);
        const check = pin && state ? checkIntegrationPin(pin, state) : { ok: false, reason: "disconnected" } as const;
        if (!check.ok) {
          throw new Error(
            `${entry.manifest.name} moved after this run started (${check.reason}). Start a new run.`,
          );
        }
      }
      const factory = entry.runtime.capabilities.vcs;
      const adapter = (factory as unknown as (
        context: IntegrationContext<IntegrationManifest>,
        repository: { repoPath: string; baseBranch: string },
      ) => VcsIntegrationAdapter)(entry.ctx, { repoPath: "", baseBranch: "" });
      if (!adapter.listRepositories) {
        throw new Error(`${entry.manifest.name} does not support repository listing.`);
      }
      repositories.push(...await adapter.listRepositories());
    } catch (error) {
      failures.push({
        provider: entry.manifest.id,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    }
  }
  return { repositories, providers: usable.map((entry) => entry.manifest.id), failures };
}

export async function listVcsRepositories(options: {
  neededProviders?: Iterable<string>;
  integrationPins?: readonly IntegrationConnectionPin[];
} = {}): Promise<{
  repositories: import("@integrations/sdk").VcsRepositoryMetadata[];
  providers: string[];
  failures: Array<{ provider: string; message: string; error: unknown }>;
}> {
  const needed = options.neededProviders ? new Set(options.neededProviders) : null;
  const coreProviders = getConfiguredVcsProviders().filter(
    (provider) => !needed || needed.has(provider.kind),
  );
  const { listRepositoriesAcrossProviders } = await import(
    "../../adapters/vcs/repository-directory.js"
  );
  const [core, integrations] = await Promise.all([
    listRepositoriesAcrossProviders(coreProviders),
    listIntegrationVcsRepositories(options),
  ]);
  return {
    repositories: [...core.repositories, ...integrations.repositories],
    providers: [...coreProviders.map((provider) => provider.kind), ...integrations.providers],
    failures: [...core.failures, ...integrations.failures],
  };
}

async function resolveCommitIdentity(
  provider: ReturnType<typeof getConfiguredVcsProviders>[number],
): Promise<{ name: string; email: string }> {
  if (env.COMMIT_AUTHOR && env.COMMIT_EMAIL) {
    return { name: env.COMMIT_AUTHOR, email: env.COMMIT_EMAIL };
  }
  return getBotIdentity(provider.auth);
}
