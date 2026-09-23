/**
 * The issue tracker's word on the query templates a definition carries.
 *
 * The investigate block's `issueTrackerQueryTemplate` is written in the
 * connected tracker's own query language, so only the tracker can say whether
 * it would run it: its runtime carries `issueTrackerQueryRule`, the same rule
 * its adapter applies before it sends a query.
 *
 * The rule is newer than many templates people saved and published, and it
 * refuses some of them (Jira's adapter always dropped them at run time, in
 * silence). So it refuses only what an author is writing now, never what a
 * definition already runs: a template the deployed version carries is shown
 * as a notice and left alone, and the paths that make a stored version live
 * again (rollback, restore, enable) do not ask at all. What the rule refuses
 * never blocks the incident tools or an edit to another block.
 */
import type {
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationNotice,
} from "@shared/contracts";
import type { IssueTrackerQueryRule } from "@integrations/sdk";
import { integrationRuntime } from "@integrations/registry/worker";
import type { DeploymentIntegrations } from "../../engine/definition/integration-availability.js";

/** The connected tracker's rule, with its name for the sentence a person reads. */
export interface TrackerQueryRule {
  readonly name: string;
  readonly rule: IssueTrackerQueryRule;
}

/**
 * The rule of the one usable tracker, or null.
 *
 * Only while exactly one tracker is usable, which is the only case in which a
 * run would send a query anywhere: with none, or with two and nobody chosen,
 * a run refuses to read tickets at all, and picking one here would judge a
 * template by a language nobody chose.
 */
export function trackerQueryRuleFor(
  integrations: DeploymentIntegrations,
  runtimeOf: (id: string) => { readonly issueTrackerQueryRule?: IssueTrackerQueryRule } | undefined = integrationRuntime,
): TrackerQueryRule | null {
  const trackers = integrations.providers.get("issue_tracker") ?? [];
  if (trackers.length !== 1) return null;
  const id = trackers[0]!;
  const rule = runtimeOf(id)?.issueTrackerQueryRule;
  if (!rule) return null;
  return { name: integrations.byId.get(id)?.name ?? id, rule };
}

export interface TrackerQueryTemplateFindings {
  /** Templates the tracker would not run and the deployed version does not carry: refused. */
  readonly refused: WorkflowDefinitionValidationIssue[];
  /** Templates the tracker would not run that the deployed version already runs: shown, never refused. */
  readonly standing: WorkflowDefinitionValidationNotice[];
}

const NO_FINDINGS: TrackerQueryTemplateFindings = { refused: [], standing: [] };

function templatesOf(definition: WorkflowDefinition): Array<{ index: number; nodeId: string; template: string }> {
  return definition.nodes.flatMap((node, index) => {
    if (node.type !== "investigate") return [];
    const template = node.configuration.issueTrackerQueryTemplate;
    if (typeof template !== "string" || template.trim() === "") return [];
    return [{ index, nodeId: node.id, template: template.trim() }];
  });
}

/**
 * What the tracker says about each template in `definition`.
 *
 * `deployed` is the version that runs today, or null when nothing does. A
 * template it carries, on any investigate node, is not new: moving it to
 * another node or copying a block changes nothing the definition does.
 */
export function trackerQueryTemplateFindings(
  definition: WorkflowDefinition,
  tracker: TrackerQueryRule | null,
  deployed: WorkflowDefinition | null,
): TrackerQueryTemplateFindings {
  if (tracker === null) return NO_FINDINGS;
  const live = new Set(deployed === null ? [] : templatesOf(deployed).map(({ template }) => template));
  const findings: { refused: WorkflowDefinitionValidationIssue[]; standing: WorkflowDefinitionValidationNotice[] } = {
    refused: [],
    standing: [],
  };
  for (const { index, nodeId, template } of templatesOf(definition)) {
    const problem = tracker.rule.problem(template);
    if (problem === null) continue;
    const path = `/nodes/${index}/configuration/issueTrackerQueryTemplate`;
    if (live.has(template)) {
      findings.standing.push({
        code: "tracker_query_not_run",
        nodeId,
        path,
        message: `${tracker.name} does not run this query, so the block searches without it. It is live in the deployed version, so saving does not refuse it; fix it when you next change this block. ${problem}`,
      });
    } else {
      findings.refused.push({
        code: "tracker_query_refused",
        severity: "error",
        nodeId,
        path,
        message: `${tracker.name} would not run this query, so the block would search without it. ${problem}`,
      });
    }
  }
  return findings;
}
