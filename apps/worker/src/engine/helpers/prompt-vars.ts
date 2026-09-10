export {
  substituteNodePromptParams,
  substitutePromptVariables,
  VARIABLE_PARAM_KEYS,
  type PromptVariableValues,
} from "@shared/prompts";
import type { PromptVariableValues } from "@shared/prompts";
import type { EngineCtx } from "../blocks/support/types.js";
import { formatPRComments } from "../../sandbox/context.js";

/** Fields of the run context that back the prompt variables. A Pick (not the
 *  whole EngineCtx) so callers and tests only need to supply what is read. */
type PromptVariableSource = Pick<
  EngineCtx,
  | "runId"
  | "ticket"
  | "ticketUrl"
  | "branchName"
  | "entry"
  | "researchPlanMarkdown"
  | "changeSummary"
  | "publication"
  | "selectedRepositories"
  | "repositoryContexts"
>;

/** Snapshot every prompt variable for the current point of the run. Called per
 *  block execution because researchPlanMarkdown / publication / selectedRepositories
 *  mutate mid-run. */
export function buildPromptVariables(ctx: PromptVariableSource): PromptVariableValues {
  const { entry, ticket, publication, selectedRepositories, repositoryContexts } = ctx;
  const prEntry = entry.kind === "pr_trigger" ? entry.pr : null;
  // Human PR review feedback for {{pr_review_feedback}}: one block per
  // workflow-owned repo, each under its own `provider:repoPath` heading so a
  // multi-repo run never conflates same-path comments across checkouts. Same
  // formatter the fix/impl context envelopes use. Empty when no feedback yet.
  const prReviewFeedback = repositoryContexts
    .filter((context) => context.prComments.length > 0)
    .map(
      (context) =>
        `### ${context.repository.provider}:${context.repository.repoPath}\n${formatPRComments(context.prComments)}`,
    )
    .join("\n\n");
  // The PR this run opened (open_pr / finalize_workspace) once publication lands.
  const openedPr = publication?.prs[0];

  const prNumber = prEntry
    ? String(prEntry.prNumber)
    : openedPr
      ? String(openedPr.id)
      : "";
  const prUrl = prEntry ? prEntry.prUrl : (openedPr?.url ?? "");
  const prTitle = prEntry ? prEntry.title : "";
  const repoPath = prEntry ? prEntry.repoPath : (selectedRepositories[0]?.repoPath ?? "");

  return {
    ticket_key: ticket.identifier,
    ticket_title: ticket.title,
    ticket_url: ctx.ticketUrl,
    ticket_description: ticket.description,
    ticket_acceptance_criteria: ticket.acceptanceCriteria ?? "",
    ticket_labels: ticket.labels.join(", "),
    change_summary: ctx.changeSummary,
    branch_name: ctx.branchName,
    run_id: ctx.runId,
    plan_markdown: ctx.researchPlanMarkdown ?? "",
    pr_number: prNumber,
    pr_url: prUrl,
    pr_title: prTitle,
    repo_path: repoPath,
    pr_review_feedback: prReviewFeedback,
  };
}
