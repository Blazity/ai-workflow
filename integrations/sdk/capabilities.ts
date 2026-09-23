import type { AgentTracingAdapter } from "./agent-tracing";
import type { IssueTrackerAdapter } from "./issue-tracker";
import type { MemoryAdapter } from "./memory";
import type { MessagingAdapter, MessagingSender } from "./messaging";
import type { VCSAdapter, VcsIntegrationAdapter } from "./vcs";

/**
 * Integration capabilities: the seams in core that an integration can fill.
 * Not to be confused with a harness capability, which is what a model harness
 * advertises (reasoning efforts, service tiers) in the model catalog.
 *
 * `one` means one active provider per deployment, chosen by an admin when
 * several are connected. `many` means every connected provider serves at once
 * (for `vcs`, core picks the provider of each repository).
 *
 * A capability whose `reservedFor` is set has an id and a cardinality but no
 * port yet. Declaring it is a type error and a conformance failure until the
 * named stage designs its port; nothing here guesses that shape.
 *
 * `label` is what a person reads for the capability, capitalised as a heading
 * (the Integrations page's capability rows); a sentence lowercases it. One
 * home, so the editor's refusals and the dashboard cannot name the same
 * capability two ways, and a capability added here arrives with its name.
 */
export const INTEGRATION_CAPABILITIES = {
  issue_tracker: { cardinality: "one", reservedFor: null, label: "Issue tracker" },
  vcs: { cardinality: "many", reservedFor: null, label: "Version control" },
  messaging: { cardinality: "one", reservedFor: null, label: "Messaging" },
  /**
   * Designed in S13 against the built-in store and two external engines.
   *
   * `one`, and the one is the built-in store on a deployment that connects
   * nothing: memory is the only capability core can serve by itself, so
   * connecting an integration REPLACES a provider rather than supplying the
   * first one. A deployment that never opens the Integrations page keeps
   * exactly the memory it has.
   */
  memory: { cardinality: "one", reservedFor: null, label: "Memory" },
  /** Every connected provider watches every agent sandbox; see `agent-tracing.ts`. */
  agent_tracing: { cardinality: "many", reservedFor: null, label: "Agent tracing" },
  /** MCP servers handed to sandbox agents; waits for AIW-392, a later plan. */
  agent_tools: {
    cardinality: "many",
    reservedFor: "a later plan, after AIW-392",
    label: "Agent tools",
  },
} as const satisfies Record<
  string,
  { cardinality: "one" | "many"; reservedFor: string | null; label: string }
>;

export type IntegrationCapabilityId = keyof typeof INTEGRATION_CAPABILITIES;

/** What a provider of each capability implements. Only ported capabilities appear. */
export interface IntegrationCapabilityPorts {
  issue_tracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  memory: MemoryAdapter;
  agent_tracing: AgentTracingAdapter;
}

/** A capability an integration may declare and implement today. */
export type ProvidedCapabilityId = keyof IntegrationCapabilityPorts;

/**
 * How a port member reaches another adapter: a method that `returns` one, or
 * a property that `holds` one.
 */
export type NestedAdapterRole = "returns" | "holds";

type NestedMembers<Port> = { readonly [Member in keyof Port]?: NestedAdapterRole };

/** Each port with the optional surfaces its providers may add (`vcs` has some). */
type AdapterSurface = Omit<IntegrationCapabilityPorts, "vcs"> & { vcs: VcsIntegrationAdapter };

/**
 * Every member of a port that returns or holds another adapter, meaning an
 * object whose methods are integration code of their own.
 *
 * Core redacts what an integration's adapter throws at one boundary
 * (`apps/worker/src/services/integrations/usable.ts`) and follows exactly the
 * members named here to reach the adapters inside; every other value a port
 * hands over is data and is passed on untouched. A port that grows such a
 * member lists it here in the same change, or what that adapter throws
 * reaches core unredacted. Every provided capability has an entry, so a new
 * port cannot be added without deciding.
 *
 * Three shapes the boundary does NOT follow, none of which a port has today;
 * a port that grows one changes the boundary in the same change:
 *
 * - a member that returns an async iterator or a stream (or is an async
 *   generator): the iterator is handed out as it is, so an error thrown while
 *   it is read arrives unredacted. Listing it as `returns` does not help,
 *   because the view wraps methods and not the iteration protocol.
 * - a method that returns `this`: the caller gets the adapter itself, not its
 *   view, and every later call through it is unwrapped.
 * - a view handed back into an adapter method that reads a private field of
 *   its argument: the view is not the adapter, so that read throws.
 */
export const NESTED_ADAPTER_MEMBERS: {
  readonly [C in ProvidedCapabilityId]: NestedMembers<AdapterSurface[C]>;
} = {
  issue_tracker: {},
  /** A skill import's four provider calls (`RepositorySkillSource`). */
  vcs: { skillSource: "returns" },
  messaging: {},
  /** The admin half (`MemoryStoreAdapter`). */
  memory: { store: "holds" },
  agent_tracing: {},
};

/** Capability ids with no port yet. See `INTEGRATION_CAPABILITIES[id].reservedFor`. */
export type ReservedCapabilityId = Exclude<IntegrationCapabilityId, ProvidedCapabilityId>;

/**
 * The repository a `vcs` adapter is created for. Field for field the shape
 * core already passes to its providers, so the move in S10 changes no caller.
 */
export interface VcsRepositoryTarget {
  /** The provider's own path for the repository, such as `owner/name` or a project id. */
  repoPath: string;
  baseBranch: string;
}

/**
 * A repository as core knows it, for a block that reaches `vcs`: the provider
 * is the id of the integration that serves it.
 */
export interface VcsRepositoryRef extends VcsRepositoryTarget {
  provider: string;
}

/**
 * How a block reaches a capability it declared in `requires.capabilities`.
 * A capability with one active provider is its adapter; `vcs`, with many, is a
 * lookup by repository.
 */
export interface IntegrationCapabilityAccess {
  issue_tracker: IssueTrackerAdapter;
  vcs: (repository: VcsRepositoryRef) => VCSAdapter;
  /**
   * Not the port. A block says what happened and searches; which conversation
   * a ticket owns is core's row and core resolves it, so a block never holds
   * a handle it could hand to the wrong ticket.
   */
  messaging: MessagingSender;
  /**
   * `memory` is absent here on purpose, the way `agent_tracing` is. Both are
   * applied by core around a run rather than called from inside a block:
   * hydrating a workspace, reading memory into a prompt and distilling at the
   * end of a run are core's orchestration, and which subject a run may write
   * to is core's answer. A block that could reach memory itself could write
   * under a subject the run does not own.
   *
   * A block may still NAME it in `requires`, which decides whether the block is
   * offered at all; it simply has no key on the context, so there is nothing to
   * call. That is what `RequiredCapabilities` in `context.ts` already does for
   * `agent_tracing`, and a fixture pins it.
   *
   * The editor answers such a requirement the way a run is answered, so a
   * block is offered exactly where its run will have the capability: `memory`
   * whenever runs here remember (the built-in store on a deployment that
   * connected no memory integration, or the one memory integration that is
   * switched on and working), and not while that integration is failing or
   * two are switched on; `agent_tracing` whenever at least one tracing
   * integration is usable.
   */
}
