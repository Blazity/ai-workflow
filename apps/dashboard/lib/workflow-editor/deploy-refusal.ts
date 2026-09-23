import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";

/**
 * What the editor says when Deploy was pressed and nothing was deployed.
 *
 * Every refusal path (the immediate validation, the validation of the saved
 * snapshot, the deploy endpoint's own 422) ends here, so a refused Deploy is
 * never silent: the person reads the first reason in their own block's name and
 * learns how many more stand behind it.
 */
export interface DeployRefusal {
  /** The sentence read first: the first issue, prefixed with its block's name. */
  sentence: string;
  /** The block the first issue belongs to, for a "show the block" action. */
  nodeId: string | null;
  /** Every issue that refused the deploy. */
  issueCount: number;
}

export function deployRefusal(
  issues: readonly WorkflowDefinitionValidationIssue[],
  nodeNames: Readonly<Record<string, string>>,
): DeployRefusal {
  const first = issues[0];
  if (!first) {
    // A refusal with no reason attached is still a refusal; saying nothing is
    // what left the button looking dead.
    return {
      sentence: "Not deployed: the workflow did not pass validation.",
      nodeId: null,
      issueCount: 0,
    };
  }
  const where =
    first.nodeId === null ? "" : `${nodeNames[first.nodeId] ?? first.nodeId}: `;
  return {
    sentence: `Not deployed. ${where}${first.message}`,
    nodeId: first.nodeId,
    issueCount: issues.length,
  };
}
