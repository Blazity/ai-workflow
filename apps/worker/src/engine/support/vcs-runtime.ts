import { integrationManifest } from "@integrations/registry";
import { VCS_LEGACY_BOT_LOGIN_FIELD } from "@integrations/sdk";
import type {
  IntegrationContext,
  IntegrationManifest,
  VCSAdapter,
  VcsHandleIdentity,
  VcsIntegrationAdapter,
  VcsSandboxCredentials,
} from "@integrations/sdk";
import type { IntegrationConnectionPin } from "@shared/contracts";
import { env, type VcsProviderKind } from "../../infra/vcs-config.js";
import {
  hasManualDispatchPrCapability,
  ManualDispatchUnsupportedError,
  type ManualDispatchPrCapableVCS,
} from "../../adapters/vcs/types.js";
import type { SandboxProviderConfig } from "../../sandbox/manager.js";
import { recordedPinFor } from "./recorded-pins.js";
import { redactingPublications, VCS_PUBLICATIONS } from "./publication-redaction.js";

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
  /** The port, reached before the connection resolves: see `DeferredVcsAdapter`. */
  vcs: DeferredVcsAdapter;
  /**
   * The same adapter once its connection has resolved (one resolution, shared
   * with `vcs`): the one to ask what the provider implements beyond the port,
   * and to call it with.
   */
  adapter: () => Promise<VcsIntegrationAdapter>;
  credentials: () => Promise<VcsSandboxCredentials>;
}

/**
 * The members of `T` that a connection resolved on first use can forward
 * honestly: the methods that return a Promise.
 *
 * A synchronous member cannot be answered before the connection resolves.
 * Forwarded anyway, it hands back a Promise, and a Promise reads as `true`:
 * that is how every failed check once compared equal to every other through
 * this runtime. So it is not in the type at all, and a caller reaching for one
 * through a deferred adapter does not compile.
 */
export type DeferredMembers<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => Promise<unknown> ? K : never]: T[K];
};

/**
 * A VCS adapter reached before its connection resolves: the port's members,
 * each forwarded once the connection has resolved, and nothing else.
 *
 * It cannot say what the provider behind it implements beyond the port, so it
 * does not pretend to: every other member reads as absent, and a capability
 * guard (`hasPRFilesCapability` and the rest) asked of it answers no. Ask the
 * resolved adapter instead (`RepositoryVcsRuntime.adapter`,
 * `resolveRepositoryVCS`). It once answered every name with a function, so
 * every guard said yes for every provider and the call then failed inside.
 */
export type DeferredVcsAdapter = DeferredMembers<VCSAdapter>;

/**
 * The port's members, which the deferred adapter forwards. Keyed by the port
 * itself, so a member added to `VCSAdapter` does not compile until it is
 * listed here too.
 */
const PORT_MEMBERS: Readonly<Record<keyof VCSAdapter, true>> = {
  createBranchIfMissing: true,
  resetOwnedBranch: true,
  createPR: true,
  push: true,
  getPRComments: true,
  postPRComment: true,
  getCheckRunResults: true,
  getPRConflictStatus: true,
  findPR: true,
  getBranchSha: true,
  getBranchShaIfExists: true,
  getPRHead: true,
  listReviewThreads: true,
  settleReviewThread: true,
  postRunFailureNote: true,
};

function isPortMember(property: PropertyKey): property is keyof VCSAdapter {
  return typeof property === "string" && Object.hasOwn(PORT_MEMBERS, property);
}

/**
 * How `provider`'s handles compare, from its integration's runtime.
 *
 * No connection is resolved for it: comparing two handles is a pure function
 * of the handles, the same for every account and repository, which is why it
 * lives on the provider rather than on the adapter above (see
 * `VcsHandleIdentity`).
 */
export async function vcsHandleIdentity(provider: string): Promise<VcsHandleIdentity> {
  const { integrationRuntime } = await import("@integrations/registry/worker");
  const identity = integrationRuntime(provider)?.vcsHandles;
  if (!identity) {
    throw new Error(
      `No integration in this build serves version control for ${provider}. The repository's provider has to be one this deployment ships.`,
    );
  }
  return identity;
}

/**
 * Resolves with no lifetime, as every resolution in this file does, on
 * purpose: a VCS adapter is held for the work it was resolved for (a listing
 * across pages, a skill import, a repository's whole prepare), every request
 * it makes is already bounded on its own, and a timer started here would
 * expire the context under whoever still holds it.
 */
async function resolveIntegrationAdapter(
  target: RepositoryVcsTarget,
): Promise<VcsIntegrationAdapter> {
  const manifest = integrationManifest(target.provider);
  if (!manifest?.capabilities.includes("vcs")) {
    throw new Error(
      `No integration in this build serves version control for ${target.provider}. The repository's provider has to be one this deployment ships.`,
    );
  }

  const { resolveUsableIntegrations, checkIntegrationPin } = await import(
    "../../services/integrations/runtime.js"
  );
  const resolved = await resolveUsableIntegrations({
    filter: (candidate) => candidate.id === target.provider,
  });
  if (!resolved.readable) {
    throw new Error(
      `Version control provider ${target.provider} could not read its integration settings: ${resolved.reason}`,
    );
  }
  // By id, not by position. The filter above already narrows to one, and that
  // is exactly why reading the first entry is dangerous: the day a caller
  // widens the filter, a repository would be worked on through whichever
  // provider happened to answer first, against another company's server, with
  // nothing to show for it in a log.
  const usable = resolved.usable.find((candidate) => candidate.manifest.id === target.provider);
  const state = resolved.states.get(target.provider);
  if (!usable || !state) {
    throw new Error(
      `Version control provider ${target.provider} is not connected. Connect it on the Integrations page.`,
    );
  }
  // Only a pin the run recorded for this provider holds the call to anything
  // (`recorded-pins.ts` is the rule). No pin proceeds against the provider as
  // it is configured right now: a caller that is not a run, a run row written
  // before the pins column existed ({@link RunIntegrationPins}), and a run
  // whose recorded pins did not name this provider, which for version control
  // is a repository it did not reach at its start.
  const recorded = recordedPinFor(target.integrationPins, target.provider, "per_repository");
  if (recorded.kind === "pinned") {
    const check = checkIntegrationPin(recorded.pin, state);
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

  // The legacy single-provider login is core's to resolve (`readVcsBotLogin`),
  // never an adapter's to read.
  const { [VCS_LEGACY_BOT_LOGIN_FIELD.key]: _legacyBotLogin, ...connectionWithoutLegacyBot } =
    usable.ctx.connection;
  const ctx = {
    ...usable.ctx,
    connection: connectionWithoutLegacyBot,
  } as unknown as IntegrationContext<IntegrationManifest>;
  const adapter = (factory as unknown as (
    context: IntegrationContext<IntegrationManifest>,
    repository: { repoPath: string; baseBranch: string },
  ) => VcsIntegrationAdapter)(ctx, target);
  // Every title, body, comment, review and status summary core publishes
  // through it is redacted with the whole set of known secrets first: one of
  // the publishing boundaries `publication-redaction.ts` lists.
  return redactingPublications(adapter, VCS_PUBLICATIONS);
}

function lazyAdapter(resolve: () => Promise<VcsIntegrationAdapter>): DeferredVcsAdapter {
  return new Proxy({} as DeferredVcsAdapter, {
    get(_target, property) {
      if (!isPortMember(property)) return;
      return async (...args: unknown[]) => {
        const concrete = await resolve();
        const member: unknown = concrete[property];
        if (typeof member !== "function") {
          throw new TypeError(`Version control provider does not support ${property}.`);
        }
        return (member as (...values: unknown[]) => unknown).apply(concrete, args);
      };
    },
    has: (_target, property) => isPortMember(property),
  });
}

export function createRepositoryVcsRuntime(target: RepositoryVcsTarget): RepositoryVcsRuntime {
  let concrete: Promise<VcsIntegrationAdapter> | undefined;
  const resolve = () => (concrete ??= resolveIntegrationAdapter(target));
  return {
    provider: target.provider,
    repoPath: target.repoPath,
    baseBranch: target.baseBranch,
    vcs: lazyAdapter(resolve),
    adapter: resolve,
    credentials: async () => {
      const adapter = await resolve();
      if (!adapter.sandboxCredentials) {
        throw new Error(
          `Version control provider ${target.provider} cannot hand a sandbox credentials to push with.`,
        );
      }
      const credentials = await adapter.sandboxCredentials();
      // An operator who pinned a commit identity means it for every provider,
      // so it overrides what the provider says its automation account is.
      return env.COMMIT_AUTHOR && env.COMMIT_EMAIL
        ? { ...credentials, commitAuthor: env.COMMIT_AUTHOR, commitEmail: env.COMMIT_EMAIL }
        : credentials;
    },
  };
}

export function createRepositoryVCS(target: RepositoryVcsTarget): DeferredVcsAdapter {
  return createRepositoryVcsRuntime(target).vcs;
}

/**
 * The repository's adapter with its connection resolved: what a caller asks
 * when it needs more than the port, a gate status or a pull request's files,
 * and has to know whether this provider offers it.
 */
export function resolveRepositoryVCS(target: RepositoryVcsTarget): Promise<VcsIntegrationAdapter> {
  return createRepositoryVcsRuntime(target).adapter();
}

export async function loadRepositoryVcsProfile(target: RepositoryVcsTarget) {
  const adapter = await resolveIntegrationAdapter(target);
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
  return {
    async getManualDispatchPullRequest(prId) {
      // The capability is asked of the resolved adapter: the deferred one
      // forwards the port and nothing else.
      const adapter = await resolveIntegrationAdapter({ ...target, baseBranch: "" });
      if (!hasManualDispatchPrCapability(adapter)) {
        throw new ManualDispatchUnsupportedError(target.provider);
      }
      return adapter.getManualDispatchPullRequest(prId);
    },
  };
}

export async function resolveConfiguredPullRequestUrl(
  url: URL,
): Promise<{ provider: string; repoPath: string; prNumber: number } | null> {
  const providerIds = new Set<string>();
  const { usableIntegrations } = await import("../../services/integrations/runtime.js");
  for (const entry of await usableIntegrations({
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  })) providerIds.add(entry.manifest.id);

  for (const provider of providerIds) {
    const adapter = await resolveIntegrationAdapter({ provider, repoPath: "", baseBranch: "" });
    const parse = adapter.parsePullRequestUrl;
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
  const { usableIntegrations } = await import("../../services/integrations/runtime.js");
  for (const entry of await usableIntegrations({
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

/**
 * Every repository this deployment can see, from every connected version
 * control provider. Until S11 a second listing sat beside this one, fetched by
 * core itself for the provider core shipped, and the two were merged; there is
 * nothing left to merge, so this is the listing.
 */
export async function listVcsRepositories(options: {
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
      // The rule `resolveIntegrationAdapter` follows: only a recorded pin holds.
      const recorded = recordedPinFor(options.integrationPins, entry.manifest.id, "per_repository");
      if (recorded.kind === "pinned") {
        const state = resolved.states.get(entry.manifest.id);
        const check = state
          ? checkIntegrationPin(recorded.pin, state)
          : ({ ok: false, reason: "disconnected" } as const);
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
      // No retry here: each page goes through the context's HTTP, which
      // retries what GitLab or GitHub can recover from (a 5xx, a 429, a
      // request that got no answer) and never a refusal. A second ladder on
      // top would multiply the attempts (three of its own, each three of the
      // context's) past the repository selection step's 60 second budget.
      repositories.push(...(await adapter.listRepositories()));
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

/**
 * The connected version-control provider that can read a repository's skills,
 * and the reader it offers.
 *
 * Picking one is a real decision, because a skill source is stored as a URL and
 * nothing in it tells us which connected integration owns it. Two rules, in
 * order:
 *
 * - **A caller that already knows names it.** Refreshing an existing artifact
 *   does: the provider is on the row (`harness_skill_artifacts.source_kind`).
 *   If that provider cannot import skills, this fails naming it rather than
 *   quietly refreshing the artifact from somebody else's repository.
 * - **A caller that does not know gets the only candidate.** A first import
 *   arrives as a URL, so it takes the single connected provider offering a
 *   skill source. When more than one offers, this refuses and names them: with
 *   no ownership signal, picking would be a guess that could read a private
 *   repository through the wrong installation.
 *
 * An unreadable settings row is kept apart from "nothing can do this", because
 * a database that did not answer for a moment is not a provider that is off.
 */
export async function resolveRepositorySkillSource(
  preferProvider?: string,
): Promise<{
  provider: string;
  source: import("@integrations/sdk").RepositorySkillSource;
}> {
  const { resolveUsableIntegrations } = await import(
    "../../services/integrations/runtime.js"
  );
  const resolved = await resolveUsableIntegrations({
    filter: (manifest) => manifest.capabilities.includes("vcs"),
  });
  if (!resolved.readable) {
    throw new Error(
      `Version control integration settings could not be read (${resolved.reason}), so no provider can import skills.`,
    );
  }

  const offering = new Map<string, VcsIntegrationAdapter>();
  const unreachable: string[] = [];
  for (const entry of resolved.usable) {
    let adapter: VcsIntegrationAdapter;
    try {
      adapter = await resolveIntegrationAdapter({
        provider: entry.manifest.id,
        repoPath: "",
        baseBranch: "",
      });
    } catch (error) {
      // One broken provider must not decide for the others.
      unreachable.push(
        `${entry.manifest.id} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (adapter.skillSource) offering.set(entry.manifest.id, adapter);
  }

  const offered = [...offering.keys()];
  const detail = unreachable.length > 0 ? ` Unreachable: ${unreachable.join("; ")}.` : "";

  if (preferProvider !== undefined) {
    const adapter = offering.get(preferProvider);
    if (!adapter) {
      throw new Error(
        `Version control provider ${preferProvider} cannot import skills. Connected providers that can: ${offered.join(", ") || "none"}.${detail}`,
      );
    }
    return { provider: preferProvider, source: adapter.skillSource!() };
  }
  if (offered.length === 0) {
    throw new Error(
      `No connected version control provider can import skills.${detail}`,
    );
  }
  if (offered.length > 1) {
    throw new Error(
      `More than one connected version control provider can import skills (${offered.join(", ")}), and a skill source URL does not say which one owns it. Import through one provider at a time.`,
    );
  }
  const provider = offered[0]!;
  return { provider, source: offering.get(provider)!.skillSource!() };
}
