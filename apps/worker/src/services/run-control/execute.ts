/**
 * Run control: which runs are live, stop this one, clear this stuck claim.
 *
 * Somebody asks for this from a chat app today and from somewhere else
 * tomorrow, so the asking and the deciding are separate. The integration
 * verifies the request, turns it into a `RunControlCommand` and renders the
 * answer in its own markup; everything here is the product's own decision, and
 * it answers in values rather than in sentences.
 *
 * Moved from `apps/worker/src/services/slack/handlers.ts`, which did the same
 * work and formatted Slack mrkdwn at the end of each function.
 */
import type {
  RunControlAnswer,
  RunControlCancelOutcome,
  RunControlCommand,
  RunControlFailedRun,
  RunControlResetOutcome,
  RunControlResetTarget,
  RunControlRun,
} from "@shared/contracts";
import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import { ticketSubject } from "../../engine/support/issue-tracker-runtime.js";
import { ticketLinksOf } from "../../engine/support/ticket-url.js";
import { logger } from "../../infra/logger.js";
import type { CancelRunDetailedInput } from "../run-lifecycle/index.js";

/** Cancels the claim it is handed, named by the subject that claim holds. */
export type CancelRunFn = (input: CancelRunDetailedInput) => Promise<boolean>;

export interface RunControlDeps {
  readonly registry: RunRegistryAdapter & ThreadStore;
  readonly issueTracker?: IssueTrackerAdapter;
  readonly cancelRun: CancelRunFn;
  /** Where a cancelled ticket goes back to. */
  readonly backlog?: IssueTrackerMoveTarget;
}

/** The link every answer carries for a ticket: the tracker's own, or none. */
function ticketLink(deps: RunControlDeps, ticketKey: string): string {
  return ticketLinksOf(deps.issueTracker)(ticketKey) ?? "";
}

export async function executeRunControlCommand(
  command: RunControlCommand,
  deps: RunControlDeps,
): Promise<RunControlAnswer> {
  switch (command.kind) {
    case "list":
      return { kind: "runs", runs: await liveRuns(deps) };
    case "summary":
      return summary(deps);
    case "status":
      return status(command.ticketKey, deps);
    case "inspect":
      return inspect(command.ticketKey, deps);
    case "cancel":
      return cancel(command.ticketKey, command.actor, deps);
    case "reset":
      return reset(command.ticketKey, deps);
  }
}

/** A run is live when the registry holds a bound, parking or parked claim for it. */
function liveOf(
  rows: readonly {
    state: string;
    runId: string | null;
    ticketKey: string | null;
  }[],
  deps: RunControlDeps,
): RunControlRun[] {
  return rows.flatMap((row) =>
    (row.state === "bound" || row.state === "parking" || row.state === "parked") &&
    row.runId &&
    row.ticketKey
      ? [run(row.ticketKey, row.runId, deps)]
      : [],
  );
}

async function liveRuns(deps: RunControlDeps): Promise<RunControlRun[]> {
  return liveOf(await deps.registry.listAll(), deps);
}

async function summary(deps: RunControlDeps): Promise<RunControlAnswer> {
  const [active, failed] = await Promise.all([
    deps.registry.listAll().catch(() => []),
    deps.registry.listAllFailed().catch(() => []),
  ]);
  const failedRuns: RunControlFailedRun[] = failed.map(({ ticketKey, meta }) => ({
    ticketKey,
    runId: meta.runId,
    ticketUrl: ticketLink(deps, ticketKey),
    failedAt: meta.failedAt,
  }));
  return { kind: "registry", active: liveOf(active, deps), failed: failedRuns };
}

async function status(ticketKey: string, deps: RunControlDeps): Promise<RunControlAnswer> {
  const entry = await deps.registry.get(await ticketSubject(ticketKey));
  const runId =
    entry &&
    (entry.state === "bound" || entry.state === "parking" || entry.state === "parked")
      ? entry.runId
      : null;
  // The sandbox lookup is best effort: a missing or transiently failing sandbox
  // must not blank out the run id we can read.
  let hasSandbox = false;
  try {
    hasSandbox = entry
      ? (await deps.registry.listSandboxes(entry.subjectKey, entry.ownerToken)).length > 0
      : false;
  } catch (error) {
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "run_control_sandbox_lookup_failed",
    );
  }
  return {
    kind: "run_status",
    ticketKey,
    ticketUrl: ticketLink(deps, ticketKey),
    runId,
    hasSandbox,
  };
}

async function inspect(ticketKey: string, deps: RunControlDeps): Promise<RunControlAnswer> {
  const entry = await deps.registry.get(await ticketSubject(ticketKey)).catch(() => null);
  const [sandboxIds, conversation, failed] = await Promise.all([
    entry
      ? deps.registry.listSandboxes(entry.subjectKey, entry.ownerToken).catch(() => [])
      : Promise.resolve([]),
    deps.registry.getParent(ticketKey).catch(() => null),
    deps.registry.isTicketFailed(ticketKey).catch(() => false),
  ]);
  return {
    kind: "entry",
    entry: {
      ticketKey,
      ticketUrl: ticketLink(deps, ticketKey),
      runId: entry?.runId ?? null,
      sandboxId: sandboxIds[0] ?? null,
      claimedAt: entry?.createdAt ? new Date(entry.createdAt).toISOString() : null,
      conversation,
      failed,
    },
  };
}

async function cancel(
  ticketKey: string,
  actor: string | undefined,
  deps: RunControlDeps,
): Promise<RunControlAnswer> {
  const entry = await deps.registry.get(await ticketSubject(ticketKey));
  const answer = (outcome: RunControlCancelOutcome, runId: string | null): RunControlAnswer => ({
    kind: "cancelled",
    ticketKey,
    ticketUrl: ticketLink(deps, ticketKey),
    runId,
    outcome,
  });
  if (!entry) return answer("not_tracked", null);

  // The reason is written into the run record and the ticket comment, so it
  // names who asked rather than where they asked from: the next provider of
  // this command would otherwise write a different sentence for one act.
  const reason = actor
    ? `Cancelled by ${actor} through a run control command`
    : "Cancelled through a run control command";

  if (entry.runId === null) {
    const ok = await deps.cancelRun({
      subjectKey: entry.subjectKey,
      ticketKey,
      target: { ownerToken: entry.ownerToken, runId: null },
      runRegistry: deps.registry,
      ...(deps.issueTracker ? { issueTracker: deps.issueTracker } : {}),
      ...(deps.backlog ? { targetColumn: deps.backlog } : {}),
      reason,
    });
    return answer(ok ? "cancelled_mid_dispatch" : "claim_not_cleared", null);
  }

  const runId = entry.runId;
  const ok = await deps.cancelRun({
    subjectKey: entry.subjectKey,
    ticketKey,
    target: { ownerToken: entry.ownerToken, runId },
    runRegistry: deps.registry,
    ...(deps.issueTracker ? { issueTracker: deps.issueTracker } : {}),
    ...(deps.backlog ? { targetColumn: deps.backlog } : {}),
    reason,
  });
  return answer(ok ? "cancelled" : "unconfirmed", runId);
}

async function reset(ticketKey: string, deps: RunControlDeps): Promise<RunControlAnswer> {
  const cleared: RunControlResetTarget[] = [];
  const failures: { target: RunControlResetTarget; reason: string }[] = [];
  let blockedByActiveRun = false;

  try {
    const entry = await deps.registry.get(await ticketSubject(ticketKey));
    if (entry?.state === "reserved") {
      const released = await deps.registry.releaseReservation(entry.subjectKey, entry.ownerToken);
      if (released) cleared.push("reservation");
      else failures.push({ target: "reservation", reason: "the reservation owner changed" });
    } else if (
      entry?.state === "bound" ||
      entry?.state === "parking" ||
      entry?.state === "parked"
    ) {
      // Deliberately not touched: clearing the claim of a live run would leave
      // the run going with nothing holding its ticket.
      blockedByActiveRun = true;
    }
  } catch (error) {
    failures.push({ target: "reservation", reason: (error as Error).message });
  }
  try {
    await deps.registry.clearFailedMark(ticketKey);
    cleared.push("failure_mark");
  } catch (error) {
    failures.push({ target: "failure_mark", reason: (error as Error).message });
  }
  try {
    await deps.registry.clearParent(ticketKey);
    cleared.push("conversation");
  } catch (error) {
    failures.push({ target: "conversation", reason: (error as Error).message });
  }

  const outcome: RunControlResetOutcome = { cleared, failures, blockedByActiveRun };
  if (failures.length > 0 || blockedByActiveRun) {
    logger.warn({ ticketKey, failures, blockedByActiveRun }, "run_control_reset_partial");
  }
  return {
    kind: "reset",
    ticketKey,
    ticketUrl: ticketLink(deps, ticketKey),
    outcome,
  };
}

function run(ticketKey: string, runId: string, deps: RunControlDeps): RunControlRun {
  return {
    ticketKey,
    runId,
    ticketUrl: ticketLink(deps, ticketKey),
  };
}

/**
 * Run control against this deployment.
 *
 * Read here rather than on the path a provider is timing: a slash command has
 * about three seconds to be acknowledged, and core is called after that.
 */
export async function runControlDeps(): Promise<RunControlDeps> {
  const { createAdapters } = await import("../../engine/support/adapters.js");
  const { cancelRun } = await import("../run-lifecycle/index.js");
  const { loadSettingsSnapshot, ticketBoardOf } = await import("../settings/index.js");
  const adapters = await createAdapters();
  // One resolution for the tracker, its board and its link. With none, the
  // commands still list and cancel runs; a cancel just has no ticket to move
  // back and no tracker to link to, which `RunControlDeps` already allows.
  const tracker = adapters.issueTrackerResolution;
  if (!tracker.ok) {
    return { registry: adapters.runRegistry, cancelRun };
  }
  const board = await ticketBoardOf(tracker, await loadSettingsSnapshot());
  return {
    registry: adapters.runRegistry,
    issueTracker: tracker.adapter,
    cancelRun,
    backlog: board.backlogTransitionId
      ? { name: board.backlogColumn, transitionId: board.backlogTransitionId }
      : board.backlogColumn,
  };
}
