import type { PullRequestComment } from "@blazebot/shared";
import type { Ticket } from "@blazebot/shared";

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

export function assembleFixingFeedbackContext(
  ticket: Ticket,
  prComments: PullRequestComment[],
  hasConflicts: boolean,
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

  if (prComments.length > 0) {
    const liked = prComments.filter((c) => c.fromApprovedReview);
    const other = prComments.filter((c) => !c.fromApprovedReview);
    const needsSubheadings = liked.length > 0 && other.length > 0;

    lines.push("", "## PR Review Feedback");

    const formatComment = (c: PullRequestComment) => {
      const location = c.path
        ? ` (\`${c.path}${c.line ? `:${c.line}` : ""}\`)`
        : "";
      lines.push("", `**${c.author}**${location}:`, c.body);
    };

    if (needsSubheadings) {
      lines.push("", "### Liked Comments");
      liked.forEach(formatComment);
      lines.push("", "### Other Comments");
      other.forEach(formatComment);
    } else {
      prComments.forEach(formatComment);
    }
  }

  if (hasConflicts) {
    lines.push(
      "",
      "## Merge Conflicts",
      "This PR has merge conflicts with the target branch. Merge the target branch and resolve all conflicts before addressing review feedback.",
    );
  }

  lines.push("", "---", promptFileContent);

  return lines.join("\n");
}
