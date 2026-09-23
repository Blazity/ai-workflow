/**
 * The issue tracker, as core reaches it.
 *
 * Core asks about tickets: read one, move it, comment on it, list the ones
 * waiting in a column. Which product answers is the deployment's business,
 * resolved here and nowhere else, and nothing in this file names one.
 *
 * Two facts stay on this side of the port and are why this module exists:
 *
 * - **A deployment may have no tracker at all.** Until S12 the site, the token
 *   and the project key were required environment variables, so the worker
 *   could not boot without Jira. They are an integration's connection now, and
 *   a deployment that never connects one is a legitimate state. Everything
 *   that used to assume a tracker existed therefore needs an answer, and the
 *   answer is a refusal that names the capability rather than a provider,
 *   because the deployment with nothing connected is exactly the one that
 *   cannot be told to go and look at a provider's page.
 * - **The board is half operator settings and half connection.** Which column
 *   is the AI column is something an operator edits; which project and which
 *   transitions reach those columns is how the tracker is wired. They are
 *   merged in one place (`services/settings/integration-settings.ts`) for a
 *   reason recorded there, and this module is the half it reads.
 */
import type { IntegrationConnectionPin } from "@shared/contracts";
import { recordedPinFor } from "./recorded-pins.js";
import { ISSUE_TRACKER_PUBLICATIONS, redactingPublications } from "./publication-redaction.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";

const NO_PROVIDER =
  "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.";

/**
 * What the tracker's connection tells core, beyond what the port answers.
 *
 * Every value here is one an operator configured and nothing can re-derive:
 * which project this deployment watches, and the transition ids for boards
 * where a column can only be reached by a named transition rather than by its
 * status name. Core carries them without knowing what they mean; the provider
 * is what turns a transition id into a move.
 */
export interface IssueTrackerWiring {
  readonly projectKey: string;
  readonly baseUrl: string;
  readonly backlogTransitionId?: string;
  readonly aiTransitionId?: string;
  readonly aiReviewTransitionId?: string;
}

export type ResolvedIssueTracker =
  | {
      readonly ok: true;
      readonly id: string;
      readonly name: string;
      readonly adapter: IssueTrackerAdapter;
      readonly wiring: IssueTrackerWiring;
    }
  | { readonly ok: false; readonly reason: string; readonly refusal: IssueTrackerRefusal };

/** The resolution when there is a tracker. */
export type ConnectedIssueTracker = Extract<ResolvedIssueTracker, { ok: true }>;

/**
 * Which kind of "no tracker" this is, because each one is acted on differently:
 *
 * - `not_connected`: nothing serves issue tracking here. A state a deployment
 *   may legitimately be in, so a caller that reports it does so quietly.
 * - `ambiguous`: two trackers serve it and none is selected. A misconfiguration
 *   that silently stops every ticket until an admin picks one, so it is loud.
 * - `unusable`: the one tracker cannot serve this (it moved under a pinned run,
 *   ships no code, cannot say which account it acts as). Loud for the same
 *   reason.
 * - `unreadable`: the settings could not be read, so nobody knows. Transient,
 *   and the only one a retry can fix.
 */
export type IssueTrackerRefusal = "not_connected" | "ambiguous" | "unusable" | "unreadable";

/**
 * The one integration serving `issue_tracker` on this deployment.
 *
 * Several usable trackers with nobody chosen is a refusal by name, never a
 * silent pick of the first: a run that read a ticket out of one of two
 * connected trackers because it happened to be first in the registry is the
 * failure nobody can explain afterwards. Mirrors `messaging.ts`, which refuses
 * the same case in the same shape.
 */
/**
 * WHO CATCHES A THROW OUT OF THIS FUNCTION, and why it is not this function.
 *
 * It answers a refusal for every state it knows about, so a throw means
 * something it does not know about: a module that failed to load, a driver
 * that gave up. Exactly one caller contains that, `createAdapters`, and
 * deliberately so: it is the one called BEFORE a caller has decided whether it
 * needs a tracker at all, by the poller at the top of a pass, so a throw there
 * cost work that has nothing to do with tickets.
 *
 * The other five callers (`coreServesIssueTracker`, `issueTrackerWiring`,
 * `ticketSubject`, `ticketSubjects`, `trackerMoveTarget`) let it through, and
 * that is the rule rather than an omission. Each is called by something that
 * has already decided it is working on a ticket, and for each of them a
 * fallback would be a wrong answer rather than a smaller one: a subject key
 * nothing else computes, a move target missing the transition the board needs,
 * a palette that offers a block whose call then fails. The containment for
 * those belongs where the ticket work as a whole can be skipped, which is the
 * ticket half of a poll pass (`triggers/polling/poll-pass.ts`) and the
 * webhook route's own handler.
 */
export async function resolveActiveIssueTracker(
  pins?: readonly IntegrationConnectionPin[],
): Promise<ResolvedIssueTracker> {
  const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
  // No lifetime: the adapter is held by whoever asked (a poll pass, a resume,
  // a run's attachment downloads) for as long as their work takes, and each of
  // its requests is bounded on its own.
  const resolved = await resolveUsableIntegrations({
    filter: (manifest) => manifest.capabilities.includes("issue_tracker"),
  });
  // Settings we could not read are not a deployment with nothing connected.
  // The two send a person to different places, and only one of them is a page.
  if (!resolved.readable) {
    return {
      ok: false,
      refusal: "unreadable",
      reason: `This deployment's integration settings could not be read (${resolved.reason}), so its issue tracker was not used.`,
    };
  }
  const usable = resolved.usable;
  if (usable.length === 0) return { ok: false, refusal: "not_connected", reason: NO_PROVIDER };
  if (usable.length > 1) {
    const names = usable.map((entry) => entry.manifest.name).join(" and ");
    return {
      ok: false,
      refusal: "ambiguous",
      reason: `${names} both provide issue tracking on this deployment and no active provider is selected, so no ticket was read.`,
    };
  }
  const [only] = usable;
  if (!only) return { ok: false, refusal: "not_connected", reason: NO_PROVIDER };

  /**
   * THE TRACKER IS PINNED BUT THE PIN IS NEVER COMPARED, and the comparison
   * below is why that sentence has to come first: it reads like a protection
   * that operates, and it does not.
   *
   * A run whose graph reaches the tracker records its pin at its start
   * (`integrationPinsFor`), but every caller in core reaches the tracker
   * through `createAdapters()` with no pins, so this comparison does not run
   * in production; `createAdapters(target, pins)` threads them the moment a
   * caller has a reason to. What it would do then: hold a run to the tracker it
   * started with, so a live change could not move which project it works in,
   * mid-run, with nobody told. Nothing about the merge may rest on it
   * operating, and the plan's S12 drain paragraph says so.
   *
   * Which pin it would compare, and what a tracker absent from the run's pins
   * means, is `recorded-pins.ts`'s rule, the one version control, messaging
   * and memory follow.
   */
  const recorded = recordedPinFor(pins, only.manifest.id, "one_per_deployment");
  if (recorded.kind !== "not_pinned") {
    const { checkIntegrationPin } = await import("../../services/integrations/runtime.js");
    const state = resolved.states.get(only.manifest.id);
    const check =
      recorded.kind === "pinned" && state
        ? checkIntegrationPin(recorded.pin, state)
        : ({ ok: false, reason: "disconnected" } as const);
    if (!check.ok) {
      return {
        ok: false,
        refusal: "unusable",
        reason: `The issue tracker ${only.manifest.name} moved after this run started (${check.reason}). Start a new run.`,
      };
    }
  }

  const factory = only.runtime.capabilities.issue_tracker;
  if (typeof factory !== "function") {
    return {
      ok: false,
      refusal: "unusable",
      reason: `${only.manifest.name} declares issue tracking and ships no code for it.`,
    };
  }
  const adapter = (factory as (ctx: unknown) => IssueTrackerAdapter)(only.ctx);

  // The one method on the port that is load-bearing for safety rather than for
  // features, checked here as well as in the type. The type holds for an
  // integration compiled in this repository; this holds for one that was not,
  // which the SDK explicitly allows. Without it, an adapter that simply left
  // the method out would make the product cancel its own runs the moment it
  // finished them, because every ticket move it makes itself would read as a
  // person pulling the ticket out, and nothing anywhere would say so.
  if (typeof adapter.getCurrentUserAccountId !== "function") {
    return {
      ok: false,
      refusal: "unusable",
      reason: `${only.manifest.name} cannot say which account it acts as, so this deployment could not tell its own ticket moves from a person's. An issue tracker has to answer that.`,
    };
  }

  const connection = only.ctx.connection as Record<string, unknown>;
  return {
    ok: true,
    id: only.manifest.id,
    name: only.manifest.name,
    // Every comment and ticket core posts through it is redacted with the whole
    // set of known secrets first: one of the publishing boundaries
    // `publication-redaction.ts` lists.
    adapter: redactingPublications(adapter, ISSUE_TRACKER_PUBLICATIONS),
    wiring: {
      projectKey: text(connection.projectKey),
      baseUrl: text(connection.baseUrl),
      ...optional("backlogTransitionId", connection.backlogTransitionId),
      ...optional("aiTransitionId", connection.aiTransitionId),
      ...optional("aiReviewTransitionId", connection.aiReviewTransitionId),
    },
  };
}

/**
 * What identifies the tracker an answer came from, for anything that keeps a
 * value across calls.
 *
 * Opaque: compared, never parsed. It exists because an admin can repoint a
 * connection while the worker is warm, and a status id resolved against the
 * old instance is not merely stale, it can never match again. One derivation
 * with two callers (the board, the reconciler), so a cache written by one and
 * read by the other agrees with itself.
 */
export function trackerIdentityOf(id: string, baseUrl: string): string {
  return `${id}\u0000${baseUrl.trim().toLowerCase()}`;
}

/**
 * The move a column name means on this deployment's board.
 *
 * A board that can be moved by status name configures no transition id, and
 * then the target is the column name alone; a board that localizes its
 * transition names needs the id, and then the target carries both.
 *
 * It exists as a function because the alternative kept appearing as
 * `(await issueTrackerWiring()).backlogTransitionId ? { ... (await
 * issueTrackerWiring()).backlogTransitionId } : name`, which reads the
 * connection out of the database TWICE to build one move, in the reconciler,
 * the cancel path and the poller alike. Both of those paths are already
 * bounded by the invocation ceiling, and one of them runs per claim.
 */
export async function trackerMoveTarget(
  columnName: string,
  which: "backlog" | "ai" | "aiReview",
): Promise<IssueTrackerMoveTarget> {
  const wiring = await issueTrackerWiring();
  const transitionId =
    which === "backlog"
      ? wiring.backlogTransitionId
      : which === "ai"
        ? wiring.aiTransitionId
        : wiring.aiReviewTransitionId;
  return transitionId ? { name: columnName, transitionId } : columnName;
}

/**
 * Whether this deployment can serve the issue tracker capability at all.
 *
 * Asked by the block palette, which offers a ticket block only where core can
 * serve it. It lives beside the resolution for the reason the sentence it
 * replaced gave: a caller that decided for itself would name a provider, and
 * the same question answered in two places is how a palette comes to offer a
 * block whose call then fails.
 */
export async function coreServesIssueTracker(): Promise<boolean> {
  return (await resolveActiveIssueTracker()).ok;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optional(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value.trim() !== "" ? { [key]: value.trim() } : {};
}

/**
 * The subject key a run following a ticket is claimed under.
 *
 * THE MOST LOAD-BEARING STRING IN THIS PRODUCT, and the reason it has a
 * function of its own. It is written into `active_runs` and compared, as a
 * string, by dispatch, cancel, the stall watchdog, the reconciler, plan
 * approval, manual dispatch and the MCP tools. If one of them derived it a
 * different way from the rest, a run in flight would become invisible to
 * whichever ones disagreed: not a compile error, not a failing test, a run
 * nobody can cancel.
 *
 * So there is one derivation, here, from the id of the integration serving
 * `issue_tracker` on this deployment. That id is `jira` today, which is
 * exactly the word the literal used to be, so nothing already written changes
 * meaning. Changing that id later is a migration over run history rather than
 * a rename, and the id's own manifest says so.
 *
 * It REFUSES when no tracker is connected rather than falling back to a name.
 * A fallback would claim a run under a key nothing else would compute, which
 * is the same invisible run by another route.
 *
 * ONE DERIVATION FOR EVERY KEY THIS BUILD WRITES, which is not the same as one
 * occurrence of the string in the repository. Two places reconstruct a key an
 * EARLIER build wrote and deliberately spell `jira` themselves:
 * `db/repositories/clarifications.ts` (a row from before `subject_key` was a
 * column) and `engine/agent-workflow.ts` (the string form of the entry point,
 * reachable only by a run suspended before it changed). Both have to spell the
 * word those rows were written with, which is a historical fact, not this
 * deployment's current configuration; deriving them from the active tracker
 * would make them read those rows wrongly the day that id changes, and the
 * workflow scope the second one sits in cannot reach a connection at all. The
 * core-reference gate allowlists exactly these two with that reason.
 */
export async function ticketSubject(ticketKey: string): Promise<string> {
  const { ticketSubjectKey } = await import("./subject-key.js");
  const resolved = await resolveActiveIssueTracker();
  if (!resolved.ok) throw new Error(resolved.reason);
  return ticketSubjectKey(resolved.id, ticketKey);
}

/**
 * The same key for a whole list of tickets, resolving the tracker ONCE.
 *
 * The same derivation as `ticketSubject`, reached through it, so there is
 * still one place that spells the string. It exists because the poller asks
 * for a subject per discovered ticket inside a `Promise.all` across the entire
 * AI column, and per-ticket meant a connection read per ticket on a path that
 * is already bounded by the invocation ceiling.
 */
export async function ticketSubjects(
  ticketKeys: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const pairs = new Map<string, string>();
  if (ticketKeys.length === 0) return pairs;
  const { ticketSubjectKey } = await import("./subject-key.js");
  const resolved = await resolveActiveIssueTracker();
  if (!resolved.ok) throw new Error(resolved.reason);
  for (const ticketKey of ticketKeys) {
    pairs.set(ticketKey, ticketSubjectKey(resolved.id, ticketKey));
  }
  return pairs;
}

/**
 * How the active tracker is wired, for a caller that needs a move target or
 * the project this deployment watches and is not holding a board already.
 *
 * ONE derivation, used everywhere, exactly as `env` was one derivation before
 * S12. The columns are deliberately not here: they are stored settings and
 * they come from `ticketBoardSettings`, which is the single place the two
 * halves meet, and its own comment records the bug that reading them twice
 * caused.
 *
 * Refuses rather than answering empty. A caller that took "" for a project key
 * would compare every ticket against nothing and ignore the lot in silence.
 */
export async function issueTrackerWiring(): Promise<IssueTrackerWiring> {
  const resolved = await resolveActiveIssueTracker();
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.wiring;
}

/**
 * What to call this deployment's issue tracker in a sentence a person reads.
 *
 * Core writes the sentence and the provider supplies its own name, so the
 * words on a ticket or a screen are unchanged while core spells no provider.
 * A deployment whose tracker could not be resolved gets the capability's own
 * words, because a blank in the middle of a sentence reads as a bug.
 */
export async function issueTrackerName(): Promise<string> {
  const resolved = await resolveActiveIssueTracker();
  return resolved.ok ? resolved.name : "the issue tracker";
}
