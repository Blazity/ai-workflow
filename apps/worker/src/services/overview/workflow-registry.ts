import type { SettingsSnapshot, WorkflowMeta } from "@shared/contracts";

/**
 * Workflows the worker actually runs. Names and blurbs are static; the
 * registry holds only identity fields: the API layer widens each entry to a
 * full `WorkflowRow` by attaching `null` metric fields.
 *
 * The gateway is empty here on purpose: which provider a workflow runs on is a
 * fact about its runs (each stored definition picks a harness per block), so
 * the aggregate fills it from what the runs recorded, and a registry read
 * without runs claims none.
 */
export function getWorkflowRegistry(_settings: SettingsSnapshot): WorkflowMeta[] {
  const gateway = "";
  return [
    {
      id: "wf_agent",
      name: "Agent",
      blurb: "Ticket → tested PR (main workflow).",
      gateway,
      primary: true,
    },
    {
      id: "wf_pre_sandbox",
      name: "Pre-sandbox",
      blurb: "Validates and prepares attachments before the agent run.",
      gateway,
    },
    {
      id: "wf_post_pr_gate",
      name: "Post-PR gate",
      blurb: "Reviews the PR after the agent opens it.",
      gateway,
    },
  ];
}
