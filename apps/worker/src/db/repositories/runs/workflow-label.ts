import { sql, type SQL } from "drizzle-orm";
import { workflowDefinitions, workflowRuns } from "../../schema.js";

/**
 * What a run is called wherever a person or an agent reads one: the workflow
 * definition it ran, with its version ("Autofix PR checks v3"), and the stored
 * `workflow_name` only for a run that names no definition.
 *
 * `workflow_name` is the Workflow DevKit function every definition runs in, so
 * it read "Agent" for every run on every surface (runs.stats, runs.get,
 * tickets.list_runs, the ticket page) and an autofix could not be told from a
 * ticket run. Read at query time, not stored: a run row already carries
 * `definition_id` and `definition_version`, so a renamed definition renames its
 * past runs too, and no migration or backfill is needed.
 *
 * One expression for every run read that shows a name, including the cost
 * view's per-workflow breakdown: grouping that view by `workflow_id` alone
 * merged every ticket workflow definition into the single "wf_agent" bucket
 * ("Agent"), so it groups by `definition_id` first and this label alongside
 * it, falling back to the raw Workflow DevKit function id and name only for a
 * run (pre-sandbox, the post-PR gate) that names no definition.
 */
export const runWorkflowLabel: SQL<string | null> = sql<string | null>`coalesce(
  (select ${workflowDefinitions.name} || coalesce(' v' || ${workflowRuns.definitionVersion}::text, '')
     from ${workflowDefinitions}
    where ${workflowDefinitions.id} = ${workflowRuns.definitionId}),
  ${workflowRuns.workflowName}
)`;
