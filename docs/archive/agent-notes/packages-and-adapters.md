# Agent notes: packages and adapters

History and reasoning moved out of the agent instruction files on 2026-09-17,
from commit 1933fa8b. Nothing here is loaded automatically; the rules in
`.claude/rules/` link here.

## From `packages/AGENTS.md`, The workflow graph package

`workflow-graph` is the home of the rules that say what a workflow definition
is, how its blocks are scheduled and how values flow between them. Stage 0 of
[the plan](../../plans/2026-09-11-workflow-graph-package.md) created it with
`v2-bindings.ts` (reference parsing and resolution, input bindings, prompt data
tokens) and `v2-branch.ts` (branch configuration recognition and evaluation).
Stage 4 added the structural half of the worker's old definition schema:
`schema.ts` (the v2 parser, the deterministic stored-shape upgrade
`normalizeV2AgentProfileConfiguration` performs, the block configuration shapes
the params map is composed from), `graph-issues.ts` (ids, ports, reachability,
cycles, loop and branch shape, per-type parameter parsing, branch and transform
reference compatibility, the two pure schedule reachability rules, the
any-scope review safety check, plus the shared issue factory and
`dedupeWorkflowDefinitionIssues`, the only de-duplication in workflow
validation) and `limits.ts` (`MAX_NODES`, `MAX_EDGES`). Stage 5 added
`policies.ts`, one entry per validation policy: `parse` (read a stored or
submitted graph into the runnable shape and check nothing else; it replaced
`upgradeStoredWorkflowDefinition`), `deploy` (the structural rules plus
everything the running deployment answers, environment availability included)
and `runLoad` (`deploy` without the availability check, for a graph that already
deployed). `deploy` and `runLoad` take the definition `parse` produced rather
than parsing again, which keeps a request to one parse; each composes the
structural rules with the worker-only half, which reaches them through the
injected `WorkflowDeploymentIssueSource`, and de-duplicates the list it
composed. That is one dedupe on top of the one the graph walk already does on
its own list, because `workflowDefinitionStructuralIssues` is a public entry
that has to return a clean list to a direct caller; both use
`dedupeWorkflowDefinitionIssues`. There is no structural-only policy: see the
open decision in the plan's stage 5 bullet. Stages 6c and 6d added the bindings
and authoring clusters: `bindings.ts` (workflow value schema assignability and
`RUN_BINDING_SCHEMA`), `available-values.ts` (the one graph walk per request
that produces the per-node contracts, the values every node may read and the
editor's data catalog), `transform.ts` (what a Transform block means and what
one run of it returns), `json-schema-authoring.ts` (the authoring-time reading
of a schema an operator typed), `workspace-access.ts` (which blocks may share a
checkout and which conflict) and `declaresRetiredSchema` in `policies.ts`. Stage
6b added the scheduler cluster: `scheduler.ts` (the v2 walk itself,
`executeV2Graph`, loop regions, checkpoints and the production dispatch bounds),
`invocation-context.ts` (cancellation and replay-safe observation for one
invocation), `interpreter.ts` (what an executor is handed, what it may report
back, and `executionError`, the one construction path for a block failure) and
the derivation behind it, `failure-message.ts` with its `clamp-text.ts`. Source
entry is `index.ts`, which re-exports every module; `exports["."]` is the only
public entry, so the worker imports `@shared/workflow-graph` and never a file
inside it.

## From `apps/worker/AGENTS.md`, worker architecture routing

`src/workflow-definition` is gone (stage 7 of
[the workflow-graph plan](../../plans/2026-09-11-workflow-graph-package.md),
and listed in `scripts/gates/no-resurrected-paths.json`).
