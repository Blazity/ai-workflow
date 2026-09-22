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
import type { ResolvedAdapters } from "../engine/support/adapters.js";
import type { ResolvedIssueTracker } from "../engine/support/issue-tracker-runtime.js";
import { ticketSubjectKey } from "../engine/support/subject-key.js";

export interface ConnectedIssueTrackerDouble {
  /** The project this deployment watches. Defaults to `PROJ`. */
  projectKey?: string;
  /** Where a person opens a ticket. Empty means no link is published. */
  baseUrl?: string;
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
    baseUrl: options.baseUrl ?? "https://tracker.example",
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
  const adapter = options.adapter ?? {};
  const resolved = { ok: true as const, id, name, adapter, wiring };
  return {
    resolveActiveIssueTracker: vi.fn(async () => resolved),
    coreServesIssueTracker: vi.fn(async () => true),
    issueTrackerWiring: vi.fn(async () => wiring),
    issueTrackerName: vi.fn(async () => name),
    // The real derivation, not a second one: the subject key is compared as a
    // string by dispatch, cancel, the watchdog and the reconciler, and a
    // double that spelled it its own way would let those disagree in a suite
    // and agree nowhere else.
    // The real derivation, so a value the board caches and the reconciler
    // reads back agree in a suite exactly as they do in production.
    trackerIdentityOf: (trackerId: string, baseUrl: string) =>
      `${trackerId}\u0000${baseUrl.trim().toLowerCase()}`,
    ticketSubject: vi.fn(async (ticketKey: string) => ticketSubjectKey("jira", ticketKey)),
    ticketSubjects: vi.fn(
      async (ticketKeys: readonly string[]) =>
        new Map(ticketKeys.map((key) => [key, ticketSubjectKey("jira", key)])),
    ),
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
      unreadable: false,
      reason,
    })),
    coreServesIssueTracker: vi.fn(async () => false),
    issueTrackerWiring: vi.fn(refuse),
    issueTrackerName: vi.fn(async () => "the issue tracker"),
    trackerIdentityOf: (trackerId: string, baseUrl: string) =>
      `${trackerId}\u0000${baseUrl.trim().toLowerCase()}`,
    ticketSubject: vi.fn(refuse),
    ticketSubjects: vi.fn(refuse),
    trackerMoveTarget: vi.fn(refuse),
  };
}

/**
 * Adapters as `createAdapters` builds them, for a suite that hands adapters to
 * its subject directly (the MCP tools, through `depsFor`).
 *
 * `tracker` is the deployment's answer: an adapter when one is connected,
 * `"not_connected"` when none is, `"unreadable"` when the integration settings
 * could not be read. The getter and `issueTrackerResolution` read that one
 * answer, as they do in the real function, so a subject that reaches the
 * tracker either way sees the same deployment. The rest is whatever the suite's
 * subject uses; a suite that passes none gets none.
 */
export function adaptersFor(
  tracker: IssueTrackerAdapter | "not_connected" | "unreadable",
  rest: Partial<Record<"vcs" | "messaging" | "runRegistry", unknown>> = {},
): ResolvedAdapters {
  const issueTrackerResolution: ResolvedIssueTracker =
    tracker === "not_connected"
      ? {
          ok: false,
          unreadable: false,
          reason:
            "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.",
        }
      : tracker === "unreadable"
        ? {
            ok: false,
            unreadable: true,
            reason:
              "This deployment's integration settings could not be read (neon: connection reset), so its issue tracker was not used.",
          }
        : {
            ok: true,
            id: "jira",
            name: "Jira",
            adapter: tracker,
            wiring: { projectKey: "PROJ", baseUrl: "https://tracker.example" },
          };
  return {
    ...rest,
    get issueTracker(): IssueTrackerAdapter {
      if (!issueTrackerResolution.ok) throw new Error(issueTrackerResolution.reason);
      return issueTrackerResolution.adapter;
    },
    issueTrackerResolution,
  } as ResolvedAdapters;
}
