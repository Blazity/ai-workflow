import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";

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
  checkResults: CheckRunResult[];
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
  const { ticket, prompt, prComments, hasConflicts, checkResults } = input;

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

## CI/CD Check Results

${formatCheckResults(checkResults)}

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

  const lineCoupled = comments
    .filter((c) => c.filePath)
    .sort((a, b) => (a.filePath! < b.filePath! ? -1 : a.filePath! > b.filePath! ? 1 : 0));
  const general = comments.filter((c) => !c.filePath);

  const parts: string[] = [];

  for (const c of lineCoupled) {
    const lineRange =
      c.startLine && c.endLine && c.startLine !== c.endLine
        ? `lines ${c.startLine}-${c.endLine}`
        : `line ${c.endLine ?? c.startLine}`;
    parts.push(
      `### ${c.filePath} (${lineRange})\n${c.author}${c.liked ? " (liked)" : ""}: ${c.body}`,
    );
  }

  for (const c of general) {
    parts.push(`${c.author}${c.liked ? " (liked)" : ""}: ${c.body}`);
  }

  return parts.join("\n\n");
}

export function formatCheckResults(checks: CheckRunResult[]): string {
  if (checks.length === 0) return "No CI/CD checks found.";

  const passed = checks.filter(
    (c) => c.status === "completed" && c.conclusion === "success",
  );
  const failed = checks.filter(
    (c) => c.status === "completed" && c.conclusion !== "success" && c.conclusion !== null,
  );

  if (failed.length === 0) return "All CI/CD checks passed.";

  const parts: string[] = [];
  if (passed.length > 0) {
    parts.push(`Passed: ${passed.map((c) => c.name).join(", ")}`);
  }

  for (const c of failed) {
    parts.push(`### Failed: ${c.name}\n${c.logs ?? `Conclusion: ${c.conclusion}`}`);
  }

  return parts.join("\n\n");
}
