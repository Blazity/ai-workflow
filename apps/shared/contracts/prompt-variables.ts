/** One {{name}} placeholder the worker substitutes into prompt-bearing block
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

/** Default {{variable}} templates for the open_pr block's title and body. New
 *  blocks are seeded with these (block registry defaults); a deployed definition
 *  authored before these fields existed falls back to them at run time. Editable
 *  per-block in the flow editor. The title carries the ticket key for tracking;
 *  the body opens with the ticket link and the agent's change summary. */
export const DEFAULT_OPEN_PR_TITLE = "[{{ticket_key}}] {{ticket_title}}";
export const DEFAULT_OPEN_PR_BODY = `**Ticket:** [{{ticket_key}}]({{ticket_url}})

## What changed
{{change_summary}}`;
