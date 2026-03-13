import type { Ticket } from "./adapters/ticket.js";

export function assembleImplementationContext(
  ticket: Ticket,
  promptFileContent: string,
): string {
  const lines = [
    "# Requirements",
    "",
    "## Ticket",
    ticket.title,
    "",
    "## Description",
    ticket.description,
  ];

  if (ticket.acceptanceCriteria) {
    lines.push("", "## Acceptance Criteria", ticket.acceptanceCriteria);
  }

  if (ticket.comments.length > 0) {
    lines.push("", "## Comments");
    for (const comment of ticket.comments) {
      lines.push(
        "",
        `**${comment.author}** (${comment.createdAt.toISOString()}):`,
        comment.body,
      );
    }
  }

  lines.push("", "---", promptFileContent);

  return lines.join("\n");
}
