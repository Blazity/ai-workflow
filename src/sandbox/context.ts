import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type { ReviewOutput } from "./agent-runner.js";
import type { DownloadedAttachment } from "./attachments.js";
import { formatAttachmentsIndex } from "./attachments.js";

interface TicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt?: string }>;
}

export interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  prComments?: PRComment[];
  checkResults?: CheckRunResult[];
  hasConflicts?: boolean;
  attachments?: DownloadedAttachment[];
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  attachments?: DownloadedAttachment[];
}

export interface ImplementationRetryContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  reviewFeedback: ReviewOutput;
  attachments?: DownloadedAttachment[];
}

export interface ReviewContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  gitDiff: string;
  attachments?: DownloadedAttachment[];
}

export function assembleResearchPlanContext(input: ResearchPlanContextInput): string {
  const { ticket, prompt, branchName, prComments, checkResults, hasConflicts, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);

  let md = `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

## Branch

${branchName}
`;

  if (prComments && prComments.length > 0) {
    md += `\n## PR Review Feedback\n\n${formatPRComments(prComments)}\n`;
  }

  if (checkResults && checkResults.length > 0) {
    md += `\n## CI/CD Check Results\n\n${formatCheckResults(checkResults)}\n`;
  }

  if (hasConflicts) {
    md += `\n## Merge Conflicts\n\nThis PR has merge conflicts. The base branch has already been merged — the repo is in a MERGING state with conflict markers in the affected files. Resolve the markers, \`git add\` the files, and run \`git merge --continue\`.\n`;
  }

  md += `\n---\n\n${prompt}\n`;
  return md;
}

export function assembleImplementationContext(input: ImplementationContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

---

${prompt}
`;
}

export function assembleImplementationRetryContext(input: ImplementationRetryContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, reviewFeedback, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Review Feedback

${reviewFeedback.feedback}

### Issues

${formatReviewIssues(reviewFeedback.issues)}

---

${prompt}
`;
}

export function assembleReviewContext(input: ReviewContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, gitDiff, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Git Diff

\`\`\`diff
${gitDiff}
\`\`\`

---

${prompt}
`;
}

function formatReviewIssues(issues: Array<{ file: string; description: string; severity: string }>): string {
  if (issues.length === 0) return "No specific issues listed.";
  return issues
    .map((i) => `- **[${i.severity}]** ${i.file}: ${i.description}`)
    .join("\n");
}

function formatComments(
  comments: Array<{ author: string; body: string; createdAt?: string }>,
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

function renderAttachmentsSection(
  attachments: DownloadedAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return "";
  return `\n${formatAttachmentsIndex(attachments)}\n`;
}
