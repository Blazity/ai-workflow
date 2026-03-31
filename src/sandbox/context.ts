import type { PRComment } from "../adapters/vcs/types.js";

interface TicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  skills?: string;
}

export interface FixingFeedbackContextInput {
  ticket: TicketData;
  prompt: string;
  skills?: string;
  prComments: PRComment[];
  hasConflicts: boolean;
}

export function assembleImplementationContext(
  input: ImplementationContextInput,
): string {
  const { ticket, prompt } = input;

  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

---

${prompt}
`;
}

export function assembleFixingFeedbackContext(
  input: FixingFeedbackContextInput,
): string {
  const { ticket, prompt, prComments, hasConflicts } = input;

  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

## PR Review Feedback

${formatPRComments(prComments)}

## Merge Conflicts

${hasConflicts ? "This PR has merge conflicts. The base branch has already been merged — the repo is in a MERGING state with conflict markers in the affected files. Resolve the markers, `git add` the files, and run `git merge --continue`." : "No merge conflicts."}

---

${prompt}
`;
}

function formatComments(
  comments: Array<{ author: string; body: string; createdAt: string }>,
): string {
  if (comments.length === 0) return "No comments.";
  return comments
    .map((c) => `${c.author}: ${c.body}`)
    .join("\n\n");
}

function formatPRComments(comments: PRComment[]): string {
  if (comments.length === 0) return "No review feedback.";
  return comments
    .map((c) => `${c.author}${c.liked ? " (liked)" : ""}: ${c.body}`)
    .join("\n\n");
}
