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

  const ticketKey = entry.ticketKey;
  if (!ticketKey) throw new Error("ticket-correlated workflow input is missing ticketKey");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const ticket = await createStepAdapters().issueTracker.fetchTicket(ticketKey);
  if (entry.kind === "ticket" && ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  return ticket;
}
resolveWorkflowTicketStep.maxRetries = 0;
