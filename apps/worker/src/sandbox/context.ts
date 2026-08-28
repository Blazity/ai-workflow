import type {
  PRComment,
  CheckRunResult,
  ReviewThread,
  ReviewThreadFeed,
} from "../adapters/vcs/types.js";
import type { ReviewResult } from "@shared/contracts";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { DownloadedAttachment } from "./attachments.js";
import { formatAttachmentsIndex } from "./attachments.js";
import {
  buildWorkspaceLocalPath,
  isValidWorkspaceLocalPath,
  type WorkspaceManifest,
} from "./repo-workspace.js";
import { selectWorkItems } from "../workflows/review-ledger.js";

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
  /** Review ledger feed for this repository's PR. Present only on the
   * triggering PR's own repository and only while REVIEW_LEDGER_ENABLED. */
  reviewThreads?: ReviewThreadFeed;
}

export interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  attachments?: DownloadedAttachment[];
  preSandboxAdditions?: PreSandboxPromptAddition[];
  selectedRepositories?: SelectedRepository[];
  repositoryContexts?: SelectedRepositoryPromptContext[];
  workspaceManifest?: WorkspaceManifest;
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  attachments?: DownloadedAttachment[];
  preSandboxAdditions?: PreSandboxPromptAddition[];
  selectedRepositories?: SelectedRepository[];
  repositoryContexts?: SelectedRepositoryPromptContext[];
  workspaceManifest?: WorkspaceManifest;
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
  workspaceManifest?: WorkspaceManifest;
}

export function assembleResearchPlanContext(input: ResearchPlanContextInput): string {
  const { ticket, prompt, branchName, attachments, preSandboxAdditions, repositoryContexts } = input;
  const selectedRepositories = input.selectedRepositories ?? repositoryContexts?.map((context) => context.repository);
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories, input.workspaceManifest);
  const repositoryContextSection = renderRepositoryContexts(repositoryContexts);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  // Same condition as renderRepositoryContexts' remediation section: when the
  // ticket's PR carries review feedback, that feedback is the task, so the
  // Resolution Check must not offer the already-resolved exit.
  const hasPrFeedback =
    (repositoryContexts ?? []).some((context) => context.prComments.length > 0) ||
    hasReviewWorkItems(repositoryContexts);

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
  if (prompt.length > 0) {
    md += `\n---\n\n${prompt}\n`;
  }
  md += `

## Repository Access Protocol

This protocol extends and overrides any older Output Format instructions above.

- Inspect only repositories already attached to the workspace.
- Exhaust the attached repositories before asking for more: search them for the
  logic the ticket touches and only then decide that something is missing.
- If an additional repository is required, return \`status: "repositories_needed"\`
  with \`repositories\` containing at most 3 exact provider/repoPath identities and
  a concrete rationale for each. Do not guess identities.
- Never ask open-ended questions such as whether any additional repositories
  exist. When a concrete piece of logic cannot be found, say exactly what you
  found, name the missing logic (for example a specific module or flow), and
  ask where that logic lives.
- When returning \`status: "completed"\`, set \`writeRepositories\` to the exact
  attached repositories the implementation must modify, and include concise
  \`repositoryEvidence\`. Every evidence item must name the exact
  \`provider:repoPath\`, the file, symbol, commit, PR, or ticket fact checked,
  and the relevant finding (for example: \`github:acme/api src/auth.ts:42 —
  token refresh is delegated to SessionStore\`). A code-changing plan must
  declare at least one write repository.
- Set fields that do not apply to \`null\`, as required by the structured schema.
- Research is read-only: do not modify files, create commits, or change branches.
`;
  if (!hasPrFeedback) {
    md += `
## Resolution Check

- Before planning any implementation, check whether the ticket is already resolved:
  read the ticket comments above (for example, a "Fixed" note), inspect the git
  history of the attached repositories for commits or merges referencing the
  ticket key or describing the same fix (\`git log\`, \`git show\`), and consider
  any pull request context provided.
- If the evidence shows the ticket is already resolved or requires no repository
  changes, return \`status: "completed"\` with \`noChangeNeeded: true\`, put the
  concrete evidence (commit SHAs, PR references, quoted ticket comment excerpts)
  into \`resolutionEvidence\`, leave \`writeRepositories\` empty, and explain the
  conclusion in the plan body.
- Only claim this when the evidence is concrete. When unsure whether the ticket
  is resolved, do not set \`noChangeNeeded\`; follow the Repository Access
  Protocol instead.
`;
  }
  return md;
}

export function assembleImplementationContext(input: ImplementationContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, attachments, preSandboxAdditions, selectedRepositories, repositoryContexts } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  const preSandboxSection = renderPreSandboxAdditions(preSandboxAdditions);
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories, input.workspaceManifest);
  // On a re-run against an existing workflow-owned PR this surfaces the human PR
  // review feedback (comments, failing checks, conflicts) so the implementation
  // agent actually addresses it. Empty on the first run, so the section vanishes.
  const repositoryContextSection = renderRepositoryContexts(repositoryContexts);
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  const runtimeData = `# Requirements

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
${preSandboxSection}`;
  return prompt.length > 0
    ? `${runtimeData}

---

${prompt}
`
    : runtimeData;
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
  const selectedRepositoriesSection = renderSelectedRepositories(selectedRepositories, input.workspaceManifest);
  const siblingRepositoriesSection = renderReviewSiblingRepositories(
    selectedRepositories,
    input.workspaceManifest,
  );
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);
  const reviewFeedbackSection = reviewFeedback
    ? `\n## Pull request review feedback\n\nState: ${reviewFeedback.state}\n\n${reviewFeedback.author}: ${reviewFeedback.body}\n`
    : "";
  const runtimeData = `# Requirements

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
${reviewFeedbackSection}${selectedRepositoriesSection}${siblingRepositoriesSection}
${preSandboxSection}`;
  return prompt.length > 0
    ? `${runtimeData}

---

${prompt}
`
    : runtimeData;
}

function renderReviewSiblingRepositories(
  repositories: SelectedRepository[] | undefined,
  manifest: WorkspaceManifest | undefined,
): string {
  const siblings = (repositories ?? []).filter(
    (repo) => repo.reviewPullRequest && !repo.workflowOwnedBranch,
  );
  if (siblings.length === 0) return "";
  const lines = siblings.map((repo) => {
    const index = repositories!.indexOf(repo);
    const localPath = resolveSelectedRepositoryPath(repo, index, manifest);
    const pr = repo.reviewPullRequest!;
    return `- \`${repo.repoPath}\` at \`${localPath}\` (read-only), PR: ${pr.url}, reviewed SHA: \`${pr.headSha ?? "unknown"}\``;
  });
  return `
## Review Sibling Repositories

These repositories belong to the same workflow run. Inspect them for cross-repository consistency, but do not modify them. If a finding targets one, set its \`repo\` field to the exact repository path above.

${lines.join("\n")}
`;
}

export interface FixContextInput {
  ticket: TicketData;
  prComments: PRComment[];
  failedChecks: CheckRunResult[];
  reviewResults?: ReviewResult[];
  conflictNotes?: string;
  instructions?: string;
  repositories: SelectedRepository[];
  workspaceManifest?: WorkspaceManifest;
  /** Review ledger feed for the PR under repair; supersedes prComments. */
  reviewThreads?: ReviewThreadFeed;
}

/**
 * Assemble the fix-phase prompt context. Mirrors {@link assembleImplementationContext}
 * but frames the work as addressing review feedback and failing checks on an
 * existing PR rather than implementing a plan from scratch. Optional sections are
 * omitted when their inputs are empty so the prompt stays focused on the fix.
 */
export function assembleFixContext(input: FixContextInput): string {
  const {
    ticket,
    prComments,
    failedChecks,
    reviewResults,
    conflictNotes,
    instructions,
    repositories,
  } = input;
  // Same substitution as the ticket-side prompt: the aliased feed supersedes the
  // flat list for the threads it carries, and only for those.
  const feed = input.reviewThreads;
  const reviewThreadsSection = feed ? renderReviewThreads(feed) : "";
  const uncovered = feed
    ? prComments.filter((comment) => !feedCoversComment(feed, comment))
    : prComments;
  const prFeedbackSection =
    (reviewThreadsSection ? `\n${reviewThreadsSection}\n` : "") +
    (uncovered.length > 0
      ? `\n## PR Review Feedback\n\n${formatPRComments(uncovered)}\n`
      : "");
  const failedChecksSection =
    failedChecks.length > 0 ? `\n## CI/CD Check Results\n\n${formatCheckResults(failedChecks)}\n` : "";
  const internalReviewsSection =
    reviewResults && reviewResults.length > 0
      ? `\n## Internal Review Results\n\n<review-results>\n${JSON.stringify(reviewResults, null, 2)}\n</review-results>\n`
      : "";
  const conflictSection = conflictNotes ? `\n## Merge Conflicts\n\n${conflictNotes}\n` : "";
  const selectedRepositoriesSection = renderSelectedRepositories(repositories, input.workspaceManifest);
  const instructionsSection = instructions ? `\n## Fix Instructions\n\n${instructions}\n` : "";
  const clarificationsSection = renderClarificationsSection(ticket.clarifications);

  return `# Fix Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}
${clarificationsSection}${prFeedbackSection}${failedChecksSection}${internalReviewsSection}${conflictSection}${selectedRepositoriesSection}${instructionsSection}`;
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
  manifest?: WorkspaceManifest,
): string {
  if (!repositories || repositories.length === 0) return "";
  const seen = new Set<string>();
  const lines = repositories.map((repo, index) => {
    const localPath = resolveSelectedRepositoryPath(repo, index, manifest);
    if (seen.has(localPath)) {
      throw new Error(`Selected repository path is duplicated for ${repo.repoPath}`);
    }
    seen.add(localPath);
    const manifestAccess =
      manifest?.version === 2
        ? manifest.repositories.find(
            (candidate) =>
              candidate.provider === repo.provider &&
              candidate.repoPath === repo.repoPath,
          )?.access
        : undefined;
    const access = manifestAccess
      ? ` (${manifestAccess === "write" ? "write" : "read-only"})`
      : "";
    return `- \`${repo.provider}:${repo.repoPath}\` at \`${localPath}\`${access} - ${repo.selectedRationale}`;
  });
  const instruction =
    manifest?.version === 2
      ? "Only repositories marked write may be modified. Read-only repositories are context only and must not be changed."
      : "Edit only these Run Workspace repositories:";
  return `\n## Selected Repositories\n\n${instruction}\n\n${lines.join("\n")}\n`;
}

/**
 * Resolve a selected repository's checkout path from the trusted manifest so the
 * prompt reports where the repository actually lives. On a discovery-promoted
 * workspace every repository lives under repos/, so reconstructing the path by
 * index (root for index 0) would feed the model the wrong location. When no
 * manifest is threaded through (callers without workspace context, unit tests)
 * the deterministic index-based path is used, preserving legacy behavior.
 */
function resolveSelectedRepositoryPath(
  repo: SelectedRepository,
  index: number,
  manifest: WorkspaceManifest | undefined,
): string {
  if (!manifest) {
    return buildWorkspaceLocalPath(repo.provider, repo.repoPath, index);
  }
  const entry = manifest.repositories.find(
    (candidate) =>
      candidate.provider === repo.provider && candidate.repoPath === repo.repoPath,
  );
  if (!entry) {
    return buildWorkspaceLocalPath(repo.provider, repo.repoPath, index);
  }
  if (!isValidWorkspaceLocalPath(entry)) {
    throw new Error(`Selected repository path is invalid for ${repo.repoPath}`);
  }
  return entry.localPath;
}

const REVIEW_THREAD_SOURCE_LABELS: Record<ReviewThread["source"], string> = {
  human: "human",
  bot: "our bot",
  third_party: "another vendor's bot",
};

function reviewThreadLabel(thread: ReviewThread): string {
  return `${thread.alias} (${REVIEW_THREAD_SOURCE_LABELS[thread.source]})`;
}

/**
 * Our own HTML markers, as written by lib/vcs-bot-identity.ts. The provider
 * hands the note back with them still in the body, and the whole alias contract
 * rests on the model never seeing a provider thread id: showing it one inside a
 * marker teaches it that such ids exist and are worth quoting back.
 */
const AI_WORKFLOW_MARKER_PATTERN = /<!--\s*ai-workflow:[^>]*-->/g;

function stripAiWorkflowMarkers(body: string): string {
  return body.replace(AI_WORKFLOW_MARKER_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim();
}

function renderReviewThreadNotes(thread: ReviewThread): string {
  return thread.notes
    .map((note) => `${note.author}: ${stripAiWorkflowMarkers(note.body)}`)
    .join("\n\n");
}

/**
 * True when this flat comment is already in the feed, keyed on author and body
 * because neither side carries a comment id. A false negative only leaves a
 * duplicate in the flat list; a false positive would delete review content from
 * the prompt, so the comparison stays exact apart from surrounding whitespace.
 */
function feedCoversComment(feed: ReviewThreadFeed, comment: PRComment): boolean {
  const body = comment.body.trim();
  return feed.threads.some((thread) =>
    thread.notes.some(
      (note) => note.author === comment.author && note.body.trim() === body,
    ),
  );
}

/** Null for a thread on the conversation rather than on a line. */
function reviewThreadLocation(thread: ReviewThread): string | null {
  if (!thread.filePath) return null;
  return typeof thread.line === "number"
    ? `in \`${thread.filePath}\` line ${thread.line}`
    : `in \`${thread.filePath}\``;
}

/**
 * The review ledger's half of the prompt. Threads arrive with an alias the code
 * assigned, and the model answers by alias: it never sees a provider id, so a
 * wrong alias is always our mapping bug rather than the model's invention.
 *
 * Two lists, never one. Work items are the threads the model must disposition;
 * threads waiting on a human and other vendors' bots are context only, and the
 * verifier rejects a disposition for them as an unknown alias, so the prompt has
 * to keep them visibly out of the answer set.
 */
function renderReviewThreads(feed: ReviewThreadFeed, repoLabel?: string): string {
  const workItems = selectWorkItems(feed);
  const contextOnly = feed.threads.filter((thread) => !workItems.includes(thread));
  if (workItems.length === 0 && contextOnly.length === 0) return "";

  const heading = repoLabel ? `## Review Threads: ${repoLabel}` : "## Review Threads";
  const parts: string[] = [heading];

  if (workItems.length > 0) {
    parts.push(
      "Every open thread on this pull request is listed below with a stable alias. " +
        "Answer every alias in this list through the `reviewThreads` field of your output.",
    );
    for (const thread of workItems) {
      const location = reviewThreadLocation(thread);
      parts.push(
        `### ${reviewThreadLabel(thread)}${location ? ` ${location}` : ", general comment"}`,
      );
      const notes = renderReviewThreadNotes(thread);
      if (notes) parts.push(notes);
    }
  }

  if (contextOnly.length > 0) {
    parts.push("### Context only: do not disposition these");
    parts.push(
      "These threads are part of the review and their content matters, but they are not yours to answer. Leave them out of `reviewThreads`.",
    );
    for (const thread of contextOnly) {
      const location = reviewThreadLocation(thread);
      const reason = thread.awaitingHuman
        ? "waiting on a human reply"
        : "not answered by this workflow";
      parts.push(
        `#### ${reviewThreadLabel(thread)}${location ? ` ${location}` : ""}: ${reason}`,
      );
      // Full bodies, exactly like a work item. A scanner's finding or a request
      // we already answered is often the only place a constraint is written
      // down, and the feed is now the only channel carrying it.
      const notes = renderReviewThreadNotes(thread);
      if (notes) parts.push(notes);
    }
  }

  if (workItems.length > 0) {
    parts.push("### How to answer");
    parts.push(
      [
        "Return one entry in `reviewThreads` for every alias listed above the context block, and for no other alias:",
        "",
        "- `actionable`: this run changes the code the thread asks about. Describe the change in `reply` in one line.",
        "- `already_addressed`: `already_addressed` means the change is on the branch right now. Set `evidence.filePath` to the thread's own file and `evidence.quote` to a literal excerpt copied from that file, close to the commented line. If it only comes into existence during this run, the disposition is `actionable`, not `already_addressed`.",
        "- `question`: the thread asks something. Answer it in `reply`.",
        "- `out_of_scope`: the request belongs somewhere else. Justify that in `reply`.",
      ].join("\n"),
    );
  }

  if (feed.truncated > 0) {
    parts.push(
      `${feed.truncated} further threads did not fit into this run and are left for the next one.`,
    );
  }
  // A different omission from the one above: these are not work waiting for the
  // next run, they are background this run never saw. Saying nothing would let
  // the model treat the visible context as the whole picture and contradict a
  // constraint written down in a thread it was never shown.
  if (feed.contextTruncated > 0) {
    parts.push(
      `${feed.contextTruncated} further threads are context only and are not shown here at all.`,
    );
  }

  return parts.join("\n\n");
}

/**
 * The comments the ledger section does NOT already show. The feed supersedes
 * the flat list only for the threads it actually carries: a GitHub review
 * submission body has no thread of its own and lives nowhere else, so dropping
 * the whole flat list would delete a "changes requested" summary from the
 * prompt.
 */
function uncoveredPrComments(context: SelectedRepositoryPromptContext): PRComment[] {
  const feed = context.reviewThreads;
  if (!feed) return context.prComments;
  return context.prComments.filter((comment) => !feedCoversComment(feed, comment));
}

/** Work items exist, so the run has explicit review requests to answer and the
 * already-resolved exit must stay closed. */
function hasReviewWorkItems(
  contexts: SelectedRepositoryPromptContext[] | undefined,
): boolean {
  return (contexts ?? []).some(
    (context) => context.reviewThreads && selectWorkItems(context.reviewThreads).length > 0,
  );
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
    // The ledger feed supersedes the flat list for its own repository: the flat
    // list carries resolved threads and our own replies with no identity, which
    // is exactly the blindness the ledger exists to remove. Feeding both would
    // invite the model to answer the same request twice, once without an alias.
    const reviewThreadsSection = context.reviewThreads
      ? renderReviewThreads(context.reviewThreads, repoPath)
      : "";
    if (reviewThreadsSection) sections.push(reviewThreadsSection);
    const flatComments = uncoveredPrComments(context);
    if (flatComments.length > 0) {
      sections.push(`## PR Review Feedback: ${repoPath}\n\n${formatPRComments(flatComments)}`);
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
