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
  repositoryContexts?: SelectedRepositoryPromptContext[];
}

export interface ReviewContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  reviewFeedback?: {
    state: "changes_requested" | "commented";
    author: string;
    body: string;
  };
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
  const { ticket, prompt, researchPlanMarkdown, attachments, preSandboxAdditions, selectedRepositories, repositoryContexts } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories);
  // On a re-run against an existing workflow-owned PR this surfaces the human PR
  // review feedback (comments, failing checks, conflicts) so the implementation
  // agent actually addresses it. Empty on the first run, so the section vanishes.
  const repositoryContextSection = renderRepositoryContexts(repositoryContexts);
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
${repositoryContextSection}${selectedRepositoriesSection}
${preSandboxSection}

---

${prompt}
`;
}

export function assembleReviewContext(input: ReviewContextInput): string {
  const {
    ticket,
    prompt,
    researchPlanMarkdown,
    reviewFeedback,
    attachments,
    preSandboxAdditions,
    selectedRepositories,
  } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  const reviewFeedbackSection = reviewFeedback
    ? `\n## Pull request review feedback\n\nState: ${reviewFeedback.state}\n\n${reviewFeedback.author}: ${reviewFeedback.body}\n`
    : "";
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
${reviewFeedbackSection}${selectedRepositoriesSection}
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
  "[Older clarification rounds omitted to fit the prompt budget.]\n\n";

function renderClarificationsSection(
  clarifications: TicketData["clarifications"],
): string {
  if (!clarifications || clarifications.length === 0) return "";

  // Kept as head/answer pairs so the hard-truncation fallback below can trim
  // the questions and the answer independently.
  const roundParts = clarifications.map((round, index) => {
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
    return {
      head: `### Round ${index + 1}\n\n${numberedQuestions}`,
      answer: `${answerLabel}: ${round.answer}`,
    };
  });
  const rounds = roundParts.map((p) => `${p.head}\n\n${p.answer}`);

  const header = "\n## Clarifications (Q&A)\n\n";
  const footer = "\n";
  const separator = "\n\n";

  const fullSection = `${header}${rounds.join(separator)}${footer}`;
  if (fullSection.length <= CLARIFICATIONS_MAX_LENGTH) return fullSection;

  // Over budget: keep WHOLE rounds newest-first so the freshest answer (the one
  // a resume exists to consume) always survives; the oldest rounds are dropped
  // first. Reserve room for the note that flags the omission.
  const bodyBudget =
    CLARIFICATIONS_MAX_LENGTH - header.length - footer.length - CLARIFICATIONS_TRUNCATION_NOTE.length;
  const kept: string[] = [];
  let used = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const cost = rounds[i]!.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > bodyBudget) break;
    kept.unshift(rounds[i]!);
    used += cost;
  }
  if (kept.length === 0) {
    // Even the newest round alone exceeds the budget: truncate its questions
    // and answer separately, the answer first. The answer is what a resume run
    // exists to consume, so it must survive even when the questions alone
    // would eat the whole budget; the questions get whatever room remains.
    const newest = roundParts[roundParts.length - 1]!;
    const answerPart = newest.answer.slice(0, Math.max(0, bodyBudget));
    const headBudget = bodyBudget - answerPart.length - separator.length;
    const headPart = headBudget > 0 ? newest.head.slice(0, headBudget) : "";
    kept.push(headPart ? `${headPart}${separator}${answerPart}` : answerPart);
  }
  return `${header}${CLARIFICATIONS_TRUNCATION_NOTE}${kept.join(separator)}${footer}`;
}

export function formatPRComments(comments: PRComment[]): string {
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
  // When any repo carries human review feedback, this is a remediation of an
  // existing PR, not a fresh build. Lead with that framing so the plan and the
  // implementation target the requested changes instead of concluding the
  // original ticket is already satisfied (its work is already on the PR branch).
  if (contexts.some((context) => context.prComments.length > 0)) {
    sections.push(
      "## Existing pull request — address this review feedback\n\n" +
        "A pull request already exists for this ticket and its original implementation is already committed on the PR branch. " +
        "Human reviewers requested the changes below. For this run, treat addressing every point of this review feedback as the task. " +
        "Do not stop or report success just because the original ticket looks already implemented.",
    );
  }
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
