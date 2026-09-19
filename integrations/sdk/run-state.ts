import type { JsonValue } from "@shared/contracts";

/**
 * Per-run integration state: one handle an integration needs created once for
 * a run and used by everything that run does with it.
 *
 * Why the contract has this at all. Some providers cannot be asked twice for
 * the same thing: a provider whose buckets are named after the ticket answers
 * a second request for `AWT-42` by creating `AWT-42.1`, so a run that asked
 * once per use would scatter itself across a new bucket every time. The value
 * therefore has to be created once and carried, and neither end can do it
 * alone: an integration has no memory between calls, and core cannot know
 * what the value means.
 *
 * How it behaves, and these are the properties to design against:
 *
 * - **Created at the run's first use of this integration**, and only of this
 *   one. Running another integration's block, or tracing with another
 *   provider, never creates this state, so a workflow that never touches the
 *   integration never asks its provider for anything. A block of the
 *   integration is a use; so is tracing an agent sandbox, for an integration
 *   that provides `agent_tracing`.
 * - **Created once, whatever happens to the run afterwards.** Core creates it
 *   inside a step that is never retried, so a run that suspends for a person
 *   and resumes two days later comes back with the same value rather than a
 *   second one, and a failure is not retried into a second bucket either.
 * - **Serializable.** It is recorded with the run and read back from that
 *   record, so it is JSON and nothing else: no client, no closure, no handle
 *   to a socket.
 * - **Nullable everywhere it is read.** Creating it may fail, and tracing a
 *   run is not worth failing it, so core carries on with `null`. An
 *   integration for which `null` means the work cannot be done says so at the
 *   point of use, in its own words, rather than doing the work without it.
 *   When core could not read this deployment's own connection settings, it
 *   does not ask the provider at all and does not remember the answer: the
 *   next use tries again, and a block that needed the state fails with a
 *   sentence about the settings rather than about the provider.
 *
 * Who sees it: `beginRun` creates it, a block reads it as `ctx.run.state`, and
 * the `agent_tracing` port reads it as `invocation.state`. Capability ports
 * other than tracing do not see it. A port that needs something kept across
 * runs (a messaging integration's thread per ticket, say) needs persistent
 * state, which is a different thing and not this.
 */
export type IntegrationRunState = Readonly<Record<string, JsonValue>>;

/** What core tells an integration about the run it is creating state for. */
export interface IntegrationRunStart {
  readonly runId: string;
  /**
   * What the run is about, as a person would name it: the ticket key for a
   * ticket run (`AWT-42`, never the provider-prefixed key core stores), and
   * the identifier core gives a pull request, webhook or schedule run that has
   * no ticket. One value for the whole run, read from one place, so a block
   * and a tracer never name the same run differently. The natural name for a
   * bucket on the provider's side.
   */
  readonly subjectKey: string;
}
