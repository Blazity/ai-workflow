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
  { name: "ticket_description", description: "Ticket description (markdown)." },
  { name: "ticket_acceptance_criteria", description: "Acceptance criteria; empty when none." },
  { name: "ticket_labels", description: "Comma-separated ticket labels." },
  { name: "branch_name", description: "Work branch for this run." },
  { name: "run_id", description: "Durable workflow run id." },
  { name: "plan_markdown", description: "Plan produced by the planning agent (or the approved plan); empty before planning." },
  { name: "pr_number", description: "PR number that triggered the run, or the PR opened by it; empty before either exists." },
  { name: "pr_url", description: "PR URL that triggered the run, or the PR opened by it; empty before either exists." },
  { name: "pr_title", description: "Title of the triggering PR; empty for non-PR runs." },
  { name: "repo_path", description: "Repository path (owner/repo) of the triggering PR, else the first selected repository." },
] as const satisfies readonly PromptVariableSpec[];

export type PromptVariableName = (typeof PROMPT_VARIABLES)[number]["name"];
