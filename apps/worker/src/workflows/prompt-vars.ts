import {
  WORKFLOW_PROMPT_PARAM_KEYS,
  type PromptVariableName,
  type WorkflowDefinitionNode,
  type WorkflowParamValue,
} from "@shared/contracts";
import type { EngineCtx } from "./blocks/types.js";
import { formatPRComments } from "../sandbox/context.js";

/** Which string/string[] params of each block type receive {{var}} substitution.
 *  Deliberately excludes machine-shaped params (branch.condition, outputSchema,
 *  model, provider, commands, target, ...). */
export const VARIABLE_PARAM_KEYS = WORKFLOW_PROMPT_PARAM_KEYS;

/** Resolved {{name}} -> text map. Missing/unavailable known values are "" (never
 *  undefined) so a substituted placeholder never leaks the string "undefined". */
export type PromptVariableValues = Partial<Record<PromptVariableName, string>>;

/** {{name}}: lowercase-leading snake token, tolerant of inner whitespace. */
const VARIABLE_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

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

/** Replace every known {{name}} in `text` with its value. Unknown names (not in
 *  `vars`) are left verbatim, including their braces, so a typo stays visible
 *  instead of vanishing. */
export function substitutePromptVariables(text: string, vars: PromptVariableValues): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name as PromptVariableName] ?? "";
    }
    return match;
  });
}

/** Substitute variables into the node's prompt-bearing params (see
 *  VARIABLE_PARAM_KEYS). Returns the SAME node object when nothing changed (block
 *  type not listed, no tokens, or no known names matched); otherwise a shallow
 *  clone with a fresh params object. Never mutates the input node. */
export function substituteNodePromptParams(
  node: WorkflowDefinitionNode,
  vars: PromptVariableValues,
): WorkflowDefinitionNode {
  const keys = VARIABLE_PARAM_KEYS[node.type];
  if (!keys) return node;

  let changed = false;
  const nextParams: Record<string, WorkflowParamValue> = { ...node.params };

  for (const key of keys) {
    const value = node.params[key];
    if (typeof value === "string") {
      const substituted = substitutePromptVariables(value, vars);
      if (substituted !== value) {
        nextParams[key] = substituted;
        changed = true;
      }
    } else if (Array.isArray(value)) {
      let arrChanged = false;
      const nextArr = value.map((item) => {
        const substituted = substitutePromptVariables(item, vars);
        if (substituted !== item) arrChanged = true;
        return substituted;
      });
      if (arrChanged) {
        nextParams[key] = nextArr;
        changed = true;
      }
    }
  }

  if (!changed) return node;
  return { ...node, params: nextParams };
}
