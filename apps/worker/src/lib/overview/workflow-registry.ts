import { env } from "../../../env.js";
import type { WorkflowMeta } from "@shared/contracts";

/**
 * Workflows the worker actually runs. Names and blurbs are static; the
 * registry holds only identity fields — the API layer widens each entry to a
 * full `WorkflowRow` by attaching `null` metric fields.
 */
export function getWorkflowRegistry(): WorkflowMeta[] {
  const gateway = env.AGENT_KIND === "codex" ? "openai" : "anthropic";
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
