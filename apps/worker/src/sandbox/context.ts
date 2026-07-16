import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { DownloadedAttachment } from "./attachments.js";
import { formatAttachmentsIndex } from "./attachments.js";
import { buildWorkspaceLocalPath } from "./repo-workspace.js";

interface TicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt?: string }>;
  clarifications?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
}

export type PreSandboxPromptTarget = "research" | "implementation" | "review";

export interface PreSandboxPromptAddition {
  target: PreSandboxPromptTarget[];
  title: string;
  content: string;
}

export interface SelectedRepositoryPromptContext {
  repository: SelectedRepository;
  prComments: PRComment[];
  checkResults: CheckRunResult[];
  hasConflicts: boolean;
}

export interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  attachments?: DownloadedAttachment[];
  preSandboxAdditions?: PreSandboxPromptAddition[];
  selectedRepositories?: SelectedRepository[];
  repositoryContexts?: SelectedRepositoryPromptContext[];
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  attachments?: DownloadedAttachment[];
  preSandboxAdditions?: PreSandboxPromptAddition[];
  selectedRepositories?: SelectedRepository[];
}

export interface ReviewContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  attachments?: DownloadedAttachment[];
  preSandboxAdditions?: PreSandboxPromptAddition[];
  selectedRepositories?: SelectedRepository[];
}

export function assembleResearchPlanContext(input: ResearchPlanContextInput): string {
  const { ticket, prompt, branchName, attachments, preSandboxAdditions, repositoryContexts } = input;
  const selectedRepositories = input.selectedRepositories ?? repositoryContexts?.map((context) => context.repository);
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories);
  const repositoryContextSection = renderRepositoryContexts(repositoryContexts);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);

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
${clarificationsSection}
## Branch

${branchName}
`;

  md += selectedRepositoriesSection;

  md += repositoryContextSection;
  md += preSandboxSection;
  md += `\n---\n\n${prompt}\n`;
  return md;
}

export function assembleImplementationContext(input: ImplementationContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, attachments, preSandboxAdditions, selectedRepositories } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}
${clarificationsSection}
## Research & Plan

${researchPlanMarkdown}
${selectedRepositoriesSection}
${preSandboxSection}

---

${prompt}
`;
}

export function assembleReviewContext(input: ReviewContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, attachments, preSandboxAdditions, selectedRepositories } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}
${clarificationsSection}
## Research & Plan

${researchPlanMarkdown}
${selectedRepositoriesSection}
${preSandboxSection}

---

${prompt}
`;
}

export interface FixContextInput {
  ticket: TicketData;
  prComments: PRComment[];
  failedChecks: CheckRunResult[];
  conflictNotes?: string;
  instructions?: string;
  repositories: SelectedRepository[];
}

/**
 * Assemble the fix-phase prompt context. Mirrors {@link assembleImplementationContext}
 * but frames the work as addressing review feedback and failing checks on an
 * existing PR rather than implementing a plan from scratch. Optional sections are
 * omitted when their inputs are empty so the prompt stays focused on the fix.
 */
export function assembleFixContext(input: FixContextInput): string {
  const { ticket, prComments, failedChecks, conflictNotes, instructions, repositories } = input;
  const prFeedbackSection =
    prComments.length > 0 ? `\n## PR Review Feedback\n\n${formatPRComments(prComments)}\n` : "";
  const failedChecksSection =
    failedChecks.length > 0 ? `\n## CI/CD Check Results\n\n${formatCheckResults(failedChecks)}\n` : "";
  const conflictSection = conflictNotes ? `\n## Merge Conflicts\n\n${conflictNotes}\n` : "";
  const selectedRepositoriesSection = renderSelectedRepositories(repositories);
  const instructionsSection = instructions ? `\n## Fix Instructions\n\n${instructions}\n` : "";
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);

  return `# Fix Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}
${clarificationsSection}${prFeedbackSection}${failedChecksSection}${conflictSection}${selectedRepositoriesSection}${instructionsSection}`;
}

function formatComments(
  comments: Array<{ author: string; body: string; createdAt?: string }>,
): string {
  if (comments.length === 0) return "No comments.";
  return comments
    .map((c) => `${c.author}: ${c.body}`)
    .join("\n\n");
}

// Prompt-budget protection: a long clarification history must not crowd out the
// rest of the prompt, so the whole rendered section is capped and truncated.
const CLARIFICATIONS_MAX_LENGTH = 16000;
const CLARIFICATIONS_TRUNCATION_NOTE =
  "\n\n[Clarifications truncated to fit the prompt budget.]\n";

function renderClarificationsSection(
  clarifications: TicketData["clarifications"],
): string {
  if (!clarifications || clarifications.length === 0) return "";

  const rounds = clarifications.map((round, index) => {
    const numberedQuestions = round.questions
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n");
    const meta = [
      round.answeredBy ? `by ${round.answeredBy}` : "",
      round.answeredAt ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    const answerLabel = meta ? `Answer (${meta})` : "Answer";
    return `### Round ${index + 1}\n\n${numberedQuestions}\n\n${answerLabel}: ${round.answer}`;
  });

  const section = `\n## Clarifications (Q&A)\n\n${rounds.join("\n\n")}\n`;
  if (section.length > CLARIFICATIONS_MAX_LENGTH) {
    return (
      section.slice(0, CLARIFICATIONS_MAX_LENGTH - CLARIFICATIONS_TRUNCATION_NOTE.length) +
      CLARIFICATIONS_TRUNCATION_NOTE
    );
  }
  return section;
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

function renderPreSandboxAdditions(
  additions: PreSandboxPromptAddition[] | undefined,
): string {
  if (!additions || additions.length === 0) return "";
  return `\n${additions
    .map(
      (addition) => `## Pre-Sandbox: ${addition.title}

This information was produced before sandbox creation.

${addition.content}`,
    )
    .join("\n\n")}\n`;
}

function renderSelectedRepositories(
  repositories: SelectedRepository[] | undefined,
): string {
  if (!repositories || repositories.length === 0) return "";
  const lines = repositories.map((repo, index) => {
    const localPath = buildWorkspaceLocalPath(repo.provider, repo.repoPath, index);
    return `- \`${repo.provider}:${repo.repoPath}\` at \`${localPath}\` - ${repo.selectedRationale}`;
  });
  return `\n## Selected Repositories\n\nEdit only these Run Workspace repositories:\n\n${lines.join("\n")}\n`;
}

function renderRepositoryContexts(
  contexts: SelectedRepositoryPromptContext[] | undefined,
): string {
  if (!contexts || contexts.length === 0) return "";

  const sections: string[] = [];
  for (const context of contexts) {
    const repoPath = `${context.repository.provider}:${context.repository.repoPath}`;
    if (context.prComments.length > 0) {
      sections.push(`## PR Review Feedback: ${repoPath}\n\n${formatPRComments(context.prComments)}`);
    }
    if (context.checkResults.length > 0) {
      sections.push(`## CI/CD Check Results: ${repoPath}\n\n${formatCheckResults(context.checkResults)}`);
    }
    if (context.hasConflicts) {
      sections.push(
        `## Merge Conflicts: ${repoPath}\n\n` +
          "This PR has merge conflicts. The base branch has already been merged into this repository checkout. " +
          "Resolve the markers in this repository, `git add` the files, and run `git merge --continue` from that repository.",
      );
    }
  }

  return sections.length > 0 ? `\n${sections.join("\n\n")}\n` : "";
}
