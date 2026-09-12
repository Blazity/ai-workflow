/** One {{name}} placeholder substituted into prompt-bearing block
 *  params at runtime. The dashboard uses this list for autocomplete and
 *  highlighting; the worker's prompt-vars module is the substitution engine. */
export interface PromptVariableSpec {
  name: string;
  description: string;
}

export const PROMPT_VARIABLES = [
  { name: "ticket_key", description: "Ticket identifier, e.g. ABC-123." },
  { name: "ticket_title", description: "Ticket title." },
  { name: "ticket_url", description: "URL of the ticket in the issue tracker; empty for non-ticket runs." },
  { name: "ticket_description", description: "Ticket description (markdown)." },
  { name: "ticket_acceptance_criteria", description: "Acceptance criteria; empty when none." },
  { name: "ticket_labels", description: "Comma-separated ticket labels." },
  { name: "change_summary", description: "Summary of what the agent changed, from the implementation phase; empty before it runs." },
  { name: "branch_name", description: "Work branch for this run." },
  { name: "run_id", description: "Durable workflow run id." },
  { name: "plan_markdown", description: "Plan produced by the planning agent (or the approved plan); empty before planning." },
  { name: "pr_number", description: "PR number that triggered the run, or the PR opened by it; empty before either exists." },
  { name: "pr_url", description: "PR URL that triggered the run, or the PR opened by it; empty before either exists." },
  { name: "pr_title", description: "Title of the triggering PR; empty for non-PR runs." },
  { name: "repo_path", description: "Repository path (owner/repo) of the triggering PR, else the first selected repository." },
  { name: "pr_review_feedback", description: "Human PR review feedback on the workflow-owned PR (review summaries, inline and conversation comments); empty when there is none." },
] as const satisfies readonly PromptVariableSpec[];

export type PromptVariableName = (typeof PROMPT_VARIABLES)[number]["name"];

/**
 * The only variables a repository rules document may render.
 *
 * Rules are compiled into an agent prompt as a section the model reads as
 * standing instructions, and everything left out of this list is text somebody
 * outside the deployment wrote: a ticket description, acceptance criteria,
 * labels, a plan, a PR title, human review comments. Rendering any of those
 * inside a "rules" heading would let a reporter file a ticket whose description
 * becomes an instruction the agent believes an operator wrote. What remains is
 * run IDENTITY: which ticket, which branch, which run, which pull request,
 * which repository. All of it is a key or a URL this platform minted or read
 * off its own provider, and none of it is prose.
 *
 * A name outside this list stays literal in the rendered rules, braces and all,
 * and is reported as unresolved. The editor's palette offers this list and not
 * the full catalogue, so the restriction is visible before it is typed.
 */
export const REPOSITORY_RULES_VARIABLE_NAMES = [
  "ticket_key",
  "ticket_url",
  "branch_name",
  "run_id",
  "pr_number",
  "pr_url",
  "repo_path",
] as const satisfies readonly PromptVariableName[];

export type RepositoryRulesVariableName =
  (typeof REPOSITORY_RULES_VARIABLE_NAMES)[number];

/** The same list as specs, for a palette. Filtered out of PROMPT_VARIABLES
 *  rather than retyped, so one description never drifts from the other. */
export const REPOSITORY_RULES_VARIABLES: readonly PromptVariableSpec[] =
  PROMPT_VARIABLES.filter((variable) =>
    (REPOSITORY_RULES_VARIABLE_NAMES as readonly string[]).includes(variable.name),
  );

/** Whether a rules document may render this name. */
export function isRepositoryRulesVariable(name: string): boolean {
  return (REPOSITORY_RULES_VARIABLE_NAMES as readonly string[]).includes(name);
}

/** Default {{variable}} templates for the open_pr block's title and body. New
 *  blocks are seeded with these (block registry defaults); a deployed definition
 *  authored before these fields existed falls back to them at run time. Editable
 *  per-block in the flow editor. The title carries the ticket key for tracking;
 *  the body opens with the ticket link and the agent's change summary. */
export const DEFAULT_OPEN_PR_TITLE = "[{{ticket_key}}] {{ticket_title}}";
export const DEFAULT_OPEN_PR_BODY = `**Ticket:** [{{ticket_key}}]({{ticket_url}})

## What changed
{{change_summary}}`;
