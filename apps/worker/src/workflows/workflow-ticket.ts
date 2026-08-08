import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "./agent-input.js";

export async function resolveWorkflowTicketStep(
  entry: AgentWorkflowInput,
  columnAi: string,
): Promise<TicketContent | null> {
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
    };
  }

  const ticketKey = entry.ticketKey;
  if (!ticketKey) throw new Error("ticket-correlated workflow input is missing ticketKey");
  const { createAdapters } = await import("../lib/adapters.js");
  const ticket = await createAdapters().issueTracker.fetchTicket(ticketKey);
  if (entry.kind === "ticket" && ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  return ticket;
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
