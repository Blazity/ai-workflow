/** One {{name}} variable. The worker substitutes these with
 *  substitutePromptVariables (prompt-vars) into repository rules and the
 *  default Open PR title and body only; a v2 block's own prompt-bearing params
 *  take {{data:...}} tokens instead and fail on a leftover {{name}}. The
 *  dashboard uses this list for autocomplete and highlighting. */
export interface PromptVariableSpec {
  name: string;
  description: string;
}

export const PROMPT_VARIABLES = [
  { name: "ticket_key", description: "Ticket identifier, e.g. ABC-123." },
  { name: "ticket_title", description: "Ticket title." },
  { name: "ticket_url", description: "URL of the ticket in the issue tracker; empty for non-ticket runs and when the tracker gives no link." },
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
  { name: "repo_path", description: "Repository path (owner/repo); in repository rules, the repository whose rules are being rendered." },
  { name: "repo_default_branch", description: "Default branch of the repository whose rules are being rendered." },
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
 * run and repository IDENTITY known before implementation begins: which
 * ticket, branch and repository. All of it is a key, URL, path or branch this
 * platform minted or read from its own provider, and none of it is prose.
 *
 * A name outside this list stays literal in the rendered rules, braces and all,
 * and is reported as unresolved. The editor's palette offers this list and not
 * the full catalogue, so the restriction is visible before it is typed.
 */
export const REPOSITORY_RULES_VARIABLE_NAMES = [
  "ticket_key",
  "ticket_url",
  "branch_name",
  "repo_path",
  "repo_default_branch",
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

const REPOSITORY_RULES_VARIABLE_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Unknown {{name}} tokens in repository rules, de-duplicated in source order. */
export function unknownRepositoryRulesVariables(rules: string): string[] {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const match of rules.matchAll(REPOSITORY_RULES_VARIABLE_PATTERN)) {
    const name = match[1];
    if (seen.has(name) || isRepositoryRulesVariable(name)) continue;
    seen.add(name);
    unknown.push(name);
  }
  return unknown;
}

/** One refusal sentence shared by the dashboard, HTTP service and MCP tool. */
export function repositoryRulesVariablesError(rules: string): string | null {
  const unknown = unknownRepositoryRulesVariables(rules);
  if (unknown.length === 0) return null;
  const noun = unknown.length === 1 ? "variable" : "variables";
  return `Unknown repository rules ${noun}: ${unknown
    .map((name) => `{{${name}}}`)
    .join(", ")}. Allowed variables: ${REPOSITORY_RULES_VARIABLE_NAMES.join(", ")}.`;
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
