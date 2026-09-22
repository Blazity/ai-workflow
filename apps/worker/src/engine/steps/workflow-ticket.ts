import type { TicketContent } from "../../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * The ticket as this run reads it, plus who the workflow itself posts as.
 *
 * The identity rides here because this is the only step that already holds an
 * issue tracker adapter before the workspace is prepared, and because it costs
 * one request per run rather than one per read. The field is optional on
 * purpose: a stored result from before this shipped is still a valid
 * `TicketContent`, and a tracker that exposes no current user answers nothing.
 *
 * `subjectTextIsPlaceholder` says the other thing a reader cannot tell by
 * looking: whether the title and description are words somebody wrote or a
 * sentence this file composed to give a run without a ticket a ticket-shaped
 * snapshot. A block that screens untrusted text has to know, because screening
 * our own sentence and reporting a verdict is worse than not screening at all.
 * Absent means authored, which is what every recorded result from before this
 * field existed was.
 */
export type WorkflowTicket = TicketContent & {
  botAccountId?: string;
  subjectTextIsPlaceholder?: true;
};

export async function resolveWorkflowTicketStep(
  entry: AgentWorkflowInput,
  columnAi: string,
): Promise<WorkflowTicket | null> {
  "use step";
  if (entry.kind === "pr_trigger" && !entry.ticketKey) {
    return {
      id: entry.subjectKey,
      identifier: entry.subjectKey,
      title: entry.pr.title || `Review ${entry.pr.repoPath}#${entry.pr.prNumber}`,
      description: `Pull request: ${entry.pr.prUrl}\nHead: ${entry.pr.headRef}@${entry.pr.headSha}`,
      acceptanceCriteria: "Review the pull request without ticket or branch mutations.",
      comments: [],
      labels: [],
      trackerStatus: "",
      attachments: [],
      // Core wrote every word above. The pull request's own body and review
      // comments are the untrusted text on this trigger, and they are not here.
      subjectTextIsPlaceholder: true,
    };
  }

  if (entry.kind === "webhook_trigger") {
    // The identifier reaches branchForTicket(), so it must be a legal git ref.
    // The subjectKey cannot be reused here: it carries colons.
    const { createHash } = await import("node:crypto");
    const deliveryHash = createHash("sha256")
      .update(entry.deliveryId)
      .digest("hex")
      .slice(0, 8);
    const identifier = `webhook-${entry.endpointId.slice(-6)}-${deliveryHash}`;
    return {
      id: identifier,
      identifier,
      // Authored: the subject and description are the payload the sender sent,
      // which is exactly the text a screen exists to look at.
      title: entry.entry.subject || `Webhook delivery ${entry.deliveryId}`,
      description: entry.entry.description,
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "",
      attachments: [],
    };
  }

  if (entry.kind === "schedule") {
    // Per OCCURRENCE, never per schedule. This identifier is the primary key of
    // the branch ledger and the Slack thread key, so one identifier per schedule
    // would land every occurrence on the first one's branch: the publication would
    // push into the existing pull request, Slack would edit the same post, and the
    // moment a human pushed a fix to that branch every later occurrence would die
    // on "branch has diverged".
    //
    // Reaches branchForTicket(), so it must be a legal git ref: the schedule id is
    // hex on an underscore prefix and the stamp is digits and one "T". The subject
    // key cannot be reused here, it carries colons.
    const identifier = `schedule-${entry.scheduleId}-${minuteStamp(entry.scheduledFor)}`;
    return {
      id: identifier,
      identifier,
      title: entry.taskTitle,
      // The instants are injected rather than left in the trigger output alone so
      // the authored instruction can be written relative to the last run ("since
      // the previous run") and still make sense to the agent reading this ticket.
      description: [
        entry.taskDescription,
        "",
        `Scheduled for: ${entry.scheduledFor}`,
        `Previous run: ${entry.previousScheduledFor ?? "none, this is the first run"}`,
        // Without this the run cannot see its own outstanding work: it branches
        // from the default branch under a fresh identity every time, so a daily
        // schedule whose pull request nobody merged would redo the same change and
        // open a duplicate, every day.
        ...(entry.previousRunPullRequests?.length
          ? [
              `Still open from the previous run: ${entry.previousRunPullRequests.join(", ")}`,
              "If that pull request already covers this run's work, do not open a second one.",
            ]
          : []),
      ].join("\n"),
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "",
      attachments: [],
      // Composed here, around the schedule's own instruction: an occurrence
      // receives nothing from outside the workflow, so there is no text a
      // person wrote at this run for anything to read.
      subjectTextIsPlaceholder: true,
    };
  }

  const ticketKey = entry.ticketKey;
  if (!ticketKey) throw new Error("ticket-correlated workflow input is missing ticketKey");
  const { createAdapters } = await import("../support/adapters.js");
  const issueTracker = (await createAdapters()).issueTracker;
  const ticket = await issueTracker.fetchTicket(ticketKey);
  if (entry.kind === "ticket" && ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  // Fail open. Knowing the bot's account id only lets later steps stop reading
  // the workflow's own questions as somebody's testimony; not knowing it is how
  // every run behaved until now, and it is not worth killing a run over. The
  // account id, never the display name: a person can be called "AI Workflow"
  // too, and an identity match that a rename can break is not an identity.
  let botAccountId: string | undefined;
  try {
    botAccountId = await issueTracker.getCurrentUserAccountId();
  } catch (err) {
    // Said out loud rather than swallowed: a tracker that stopped answering
    // "who am I" degrades the selection silently, and the log line is the only
    // way anyone would find out.
    console.error("bot_account_id_unresolved", err);
  }
  return botAccountId ? { ...ticket, botAccountId } : ticket;
}
resolveWorkflowTicketStep.maxRetries = 0;

/** UTC minute of an occurrence as YYYYMMDDTHHmm. Minute resolution because the
 *  minimum period between two occurrences is fifteen minutes, so no two of them
 *  can share a stamp, and it stays readable in a branch name. */
function minuteStamp(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    at.getUTCFullYear(),
    pad(at.getUTCMonth() + 1),
    pad(at.getUTCDate()),
    "T",
    pad(at.getUTCHours()),
    pad(at.getUTCMinutes()),
  ].join("");
}
