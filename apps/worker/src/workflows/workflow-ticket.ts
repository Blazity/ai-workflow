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
