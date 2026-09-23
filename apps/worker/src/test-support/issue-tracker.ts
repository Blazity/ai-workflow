/**
 * A deployment with an issue tracker connected, for a suite that is about
 * something else.
 *
 * Since S12 the tracker is an integration: which project this deployment
 * watches, where its tickets are read, and the transition ids its board needs
 * all come from a connection, and resolving one reads the integration settings
 * out of the database. A suite about dispatch, cancellation or the poller has
 * no opinion on any of that and no database to answer it from, so it says the
 * one thing it does mean, which is that a tracker IS connected, and gets on
 * with its subject.
 *
 * It is a stand-in, not a copy. Nothing here re-implements the resolution: how
 * a tracker is chosen, what happens when two are connected or none is, and the
 * refusal for a tracker that cannot say which account it acts as are proved
 * against the real resolver in `engine/support/issue-tracker-runtime.test.ts`.
 * A suite that is ABOUT the resolution must not use this.
 */
import { vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { Adapters } from "../engine/support/adapters.js";
import type { ResolvedIssueTracker } from "../engine/support/issue-tracker-runtime.js";
import { ticketSubjectKey } from "../engine/support/subject-key.js";

export interface ConnectedIssueTrackerDouble {
  /** The project this deployment watches. Defaults to `PROJ`. */
  projectKey?: string;
  /** Which connection this is (its configuration fingerprint). */
  connection?: string;
  /**
   * How this tracker links a ticket (the port's `ticketUrl`), for a suite
   * about the links core publishes. Absent, the tracker gives no links. Used
   * only when the suite passes no `adapter` of its own.
   */
  ticketUrl?: (ticketKey: string) => string | null;
  backlogTransitionId?: string;
  aiTransitionId?: string;
  aiReviewTransitionId?: string;
  /** The tracker's display name, for the sentences core composes about it. */
  name?: string;
  /** The adapter core is handed. A suite that never touches it passes none. */
  adapter?: unknown;
}

/**
 * The module shape `vi.mock("…/issue-tracker-runtime.js", …)` returns.
 *
 * Every export of the real module is present, because a partial double makes
 * the next caller fail with "no export is defined" rather than with whatever
 * it was really missing.
 */
export function connectedIssueTracker(options: ConnectedIssueTrackerDouble = {}) {
  const wiring = {
    projectKey: options.projectKey ?? "PROJ",
    connection: options.connection ?? "tracker-connection",
    ...(options.backlogTransitionId
      ? { backlogTransitionId: options.backlogTransitionId }
      : {}),
    ...(options.aiTransitionId ? { aiTransitionId: options.aiTransitionId } : {}),
    ...(options.aiReviewTransitionId
      ? { aiReviewTransitionId: options.aiReviewTransitionId }
      : {}),
  };
  const name = options.name ?? "Jira";
  const id = "jira";
  const adapter = options.adapter ?? (options.ticketUrl ? { ticketUrl: options.ticketUrl } : {});
  const resolved = { ok: true as const, id, name, adapter, wiring };
  return {
    resolveActiveIssueTracker: vi.fn(async () => resolved),
    issueTrackerWiring: vi.fn(async () => wiring),
    issueTrackerName: vi.fn(async () => name),
    // The real derivation, not a second one: the subject key is compared as a
    // string by dispatch, cancel, the watchdog and the reconciler, and a
    // double that spelled it its own way would let those disagree in a suite
    // and agree nowhere else.
    // The real derivation, so a value the board caches and the reconciler
    // reads back agree in a suite exactly as they do in production.
    trackerIdentityOf: (trackerId: string, connection: string) =>
      `${trackerId}\u0000${connection}`,
    ticketSubject: vi.fn(async (ticketKey: string) => ticketSubjectKey("jira", ticketKey)),
    trackerMoveTarget: vi.fn(
      async (columnName: string, which: "backlog" | "ai" | "aiReview") => {
        const transitionId =
          which === "backlog"
            ? wiring.backlogTransitionId
            : which === "ai"
              ? wiring.aiTransitionId
              : wiring.aiReviewTransitionId;
        return transitionId ? { name: columnName, transitionId } : columnName;
      },
    ),
  };
}

/**
 * A deployment with NO issue tracker connected, which is a legitimate state
 * since S12. Every read refuses with the sentence an operator would see.
 */
export function noIssueTrackerConnected(
  reason = "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.",
) {
  const refuse = async () => {
    throw new Error(reason);
  };
  return {
    resolveActiveIssueTracker: vi.fn(async () => ({
      ok: false as const,
      refusal: "not_connected" as const,
      reason,
    })),
    issueTrackerWiring: vi.fn(refuse),
    issueTrackerName: vi.fn(async () => "the issue tracker"),
    trackerIdentityOf: (trackerId: string, connection: string) =>
      `${trackerId}\u0000${connection}`,
    ticketSubject: vi.fn(refuse),
    trackerMoveTarget: vi.fn(refuse),
  };
}

/** The refusals `adaptersFor` can stand in for, each in the real sentence. */
const REFUSALS = {
  not_connected: {
    ok: false,
    refusal: "not_connected",
    reason:
      "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.",
  },
  ambiguous: {
    ok: false,
    refusal: "ambiguous",
    reason:
      "Jira and Linear both provide issue tracking on this deployment and no active provider is selected, so no ticket was read.",
  },
  unreadable: {
    ok: false,
    refusal: "unreadable",
    reason:
      "This deployment's integration settings could not be read (neon: connection reset), so its issue tracker was not used.",
  },
} as const satisfies Record<string, ResolvedIssueTracker>;

/**
 * Adapters as `createAdapters` builds them, for a suite that hands adapters to
 * its subject directly (the MCP tools, through `depsFor`).
 *
 * `tracker` is the deployment's answer: an adapter when one is connected, or
 * the refusal by name (`"not_connected"`, `"ambiguous"`, `"unreadable"`),
 * carried in `issueTrackerResolution` exactly as the real function carries it.
 * The rest is whatever the suite's subject uses; a suite that passes none gets
 * none.
 */
export function adaptersFor(
  tracker: IssueTrackerAdapter | keyof typeof REFUSALS,
  rest: Partial<Record<"vcs" | "messaging" | "runRegistry", unknown>> = {},
): Adapters {
  const issueTrackerResolution: ResolvedIssueTracker =
    typeof tracker === "string"
      ? REFUSALS[tracker]
      : {
          ok: true,
          id: "jira",
          name: "Jira",
          adapter: tracker,
          wiring: { projectKey: "PROJ", connection: "tracker-connection" },
        };
  return { ...rest, issueTrackerResolution } as Adapters;
}
