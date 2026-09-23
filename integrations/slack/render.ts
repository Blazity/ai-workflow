/**
 * Core's answer as Slack mrkdwn.
 *
 * Core answers in values (which runs, which outcome, what was cleared). Every
 * sentence a person reads in Slack is written here, because the day a second
 * messaging provider ships it writes its own and neither inherits ours.
 *
 * Moved from `apps/worker/src/services/slack/format.ts`, which built the same
 * lines straight out of the registry rows.
 */
import type {
  RunControlAnswer,
  RunControlFailedRun,
  RunControlOutcome,
  RunControlResetTarget,
  RunControlRun,
} from "@integrations/sdk";

export const HELP_TEXT = [
  "*ai-workflow commands*",
  "• `/ai-workflow list` - show every tracked workflow",
  "• `/ai-workflow status <KEY>` - show the run and sandbox tied to a ticket",
  "• `/ai-workflow cancel <KEY>` - cancel the workflow run and move the ticket back",
  "• `/ai-workflow redis inspect <KEY>` - dump the registry state for a ticket",
  "• `/ai-workflow redis summary` - summary across the whole registry",
  "• `/ai-workflow redis reset <KEY>` - clear registry entries for a ticket (does NOT cancel the run)",
].join("\n");

const RESET_TARGET_LABEL: Record<RunControlResetTarget, string> = {
  reservation: "reservation and sandboxes",
  failure_mark: "failed mark",
  conversation: "thread anchor",
};

/**
 * `asked` is what the person typed, when the command's callback kept it, so
 * the sentence can name what did not happen.
 */
export function renderOutcome(outcome: RunControlOutcome, asked?: string): string {
  return outcome.kind === "failed"
    ? renderFailure(outcome.reference, asked)
    : renderAnswer(outcome.answer);
}

/**
 * What a person reads when core could not run their command: that it did not
 * complete, what to do, and the reference an admin needs. Never the error
 * itself, which core writes to the worker's log under that reference (a failed
 * query quotes its SQL and its parameters), and never a guess about whether
 * anything changed: a cancel that failed half way may have stopped the run.
 */
function renderFailure(reference: string, asked: string | undefined): string {
  // A backtick the person typed would close the code span early.
  const what = asked ? `\`${asked.replaceAll("`", "'")}\`` : "That command";
  return `:warning: ${what} could not be completed because of an error on the AI Workflow side. Try it again in a minute; if it keeps failing, give an admin the reference \`${reference}\`, which names the error in the worker's log.`;
}

function renderAnswer(answer: RunControlAnswer): string {
  switch (answer.kind) {
    case "runs":
      return answer.runs.length === 0
        ? "No active workflows."
        : answer.runs.map((run) => `• ${link(run)} - runId: \`${run.runId}\``).join("\n");

    case "run_status": {
      const label = ticketLink(answer.ticketKey, answer.ticketUrl);
      if (!answer.runId) return `${label}: not tracked.`;
      return `${label}: runId \`${answer.runId}\`, sandbox: ${answer.hasSandbox ? "yes" : "no"}`;
    }

    case "cancelled": {
      const label = ticketLink(answer.ticketKey, answer.ticketUrl);
      switch (answer.outcome) {
        case "not_tracked":
          return `No active run for ${label}.`;
        case "cancelled_mid_dispatch":
          return `${label} was mid-dispatch; durably cancelled and cleared the claim.`;
        case "claim_not_cleared":
          return `${label} was mid-dispatch and the claim could not be cleared safely. Ownership was kept; check the logs and retry.`;
        case "unconfirmed":
          return `${label}: could not confirm cancellation of run \`${answer.runId ?? "unknown"}\`; ownership was kept for a safe retry.`;
        case "cancelled":
          return `Cancelled ${label} (runId \`${answer.runId ?? "unknown"}\`).`;
      }
      break;
    }

    case "entry": {
      const entry = answer.entry;
      return [
        `*Inspect ${ticketLink(entry.ticketKey, entry.ticketUrl)}*`,
        `• runId: ${code(entry.runId)}`,
        `• sandboxId: ${code(entry.sandboxId)}`,
        `• claimedAt: ${entry.claimedAt ?? "_none_"}`,
        `• thread anchor: ${code(entry.conversation)}`,
        `• failed: ${entry.failed ? "yes" : "no"}`,
      ].join("\n");
    }

    case "registry": {
      return [
        "*Registry snapshot*",
        `*Active runs (${answer.active.length}):*`,
        ...(answer.active.length === 0
          ? ["• _none_"]
          : answer.active.map((run) => `• ${link(run)} - \`${run.runId}\``)),
        `*Failed markers (${answer.failed.length}):*`,
        ...(answer.failed.length === 0
          ? ["• _none_"]
          : answer.failed.map(
              (run: RunControlFailedRun) => `• ${link(run)} - \`${run.runId}\` (${run.failedAt})`,
            )),
      ].join("\n");
    }

    case "reset": {
      const label = ticketLink(answer.ticketKey, answer.ticketUrl);
      const { cleared, failures, blockedByActiveRun } = answer.outcome;
      const clearedText =
        cleared.length === 0
          ? "nothing"
          : cleared.map((target) => RESET_TARGET_LABEL[target]).join(", ");
      if (failures.length === 0 && !blockedByActiveRun) {
        return `${label}: cleared ${clearedText}. The workflow run was NOT cancelled; use \`cancel\` for that.`;
      }
      const problems = failures.map(
        (failure) => `${RESET_TARGET_LABEL[failure.target]}: ${failure.reason}`,
      );
      if (blockedByActiveRun) {
        problems.unshift("an active run holds this ticket, so use `cancel` instead");
      }
      return `${label}: partial reset. Cleared ${clearedText}. Not done: ${problems.join("; ")}.`;
    }
  }
}

function link(run: RunControlRun | RunControlFailedRun): string {
  return ticketLink(run.ticketKey, run.ticketUrl);
}

function ticketLink(key: string, url: string): string {
  return url ? `<${url}|${key}>` : key;
}

function code(value: string | null): string {
  return value ? `\`${value}\`` : "_none_";
}
