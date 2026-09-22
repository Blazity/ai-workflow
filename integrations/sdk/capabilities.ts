import type { AgentTracingAdapter } from "./agent-tracing";
import type { IssueTrackerAdapter } from "./issue-tracker";
import type { MemoryAdapter } from "./memory";
import type { MessagingAdapter, MessagingSender } from "./messaging";
import type { VCSAdapter } from "./vcs";

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
 */
export const INTEGRATION_CAPABILITIES = {
  issue_tracker: { cardinality: "one", reservedFor: null },
  vcs: { cardinality: "many", reservedFor: null },
  messaging: { cardinality: "one", reservedFor: null },
  /**
   * Designed in S13 against the built-in store and two external engines.
   *
   * `one`, and the one is the built-in store on a deployment that connects
   * nothing: memory is the only capability core can serve by itself, so
   * connecting an integration REPLACES a provider rather than supplying the
   * first one. A deployment that never opens the Integrations page keeps
   * exactly the memory it has.
   */
  memory: { cardinality: "one", reservedFor: null },
  /** Every connected provider watches every agent sandbox; see `agent-tracing.ts`. */
  agent_tracing: { cardinality: "many", reservedFor: null },
  /** MCP servers handed to sandbox agents; waits for AIW-392, a later plan. */
  agent_tools: { cardinality: "many", reservedFor: "a later plan, after AIW-392" },
} as const satisfies Record<
  string,
  { cardinality: "one" | "many"; reservedFor: string | null }
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
   */
}
