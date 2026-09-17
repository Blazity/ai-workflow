---
paths:
  - "packages/workflow-graph/**"
  - "apps/worker/src/engine/definition/**"
  - "apps/worker/src/workflow-graph-suites/**"
---

# Workflow graph

- Keep pure workflow definition parsing, validation, scheduling and value-flow
  rules in `packages/workflow-graph/`. Import them only through
  `@shared/workflow-graph`; `packages/workflow-graph/index.ts` is the sole public
  entry.
- Use the policy matching the caller's question. `parse` reads and normalizes a
  stored or submitted graph without deployment checks. `deploy` checks the
  parsed definition for structural and worker-supplied deployment issues,
  including environment availability. `runLoad` performs the same checks
  without availability, so a deployed run is not refused after its environment
  changes. Pass the definition from `parse` to the next policy instead of
  parsing again.
- Pass worker knowledge into graph rules as parameters. Compose block schemas
  in `apps/worker/src/engine/definition/block-params-schemas.ts`, bind JSON
  Schema support in `apps/worker/src/engine/definition/json-schema-support.ts`,
  and bind scheduler dependencies in
  `apps/worker/src/engine/definition/scheduler-dependencies.ts`. Runtime budget
  enforcement stays in `apps/worker/src/engine/helpers/run-budget.ts`.
- Keep environment, registry and stored-state checks in
  `apps/worker/src/engine/definition/deployment-validation.ts`. Issue order is
  observable behavior, and
  `apps/worker/src/engine/definition/__golden__/definition-deployment-issues.json`
  pins it.
- Use `dedupeWorkflowDefinitionIssues` for issue de-duplication. The structural
  entry cleans its direct result, then a deployment policy cleans the composed
  structural and worker issue list.
- The package may import workspace code only from `@shared/contracts` and
  `@shared/conditions`, as allowed by `scripts/gates/tiers.json`. Declare only
  dependencies the package imports. Guard: `pnpm run gate:boundaries` and
  `pnpm run gate:unused`.
- Keep workflow graph vitest suites in
  `apps/worker/src/workflow-graph-suites/`. When another suite's subject moves
  into the package, add that suite to `WORKFLOW_GRAPH_TESTS` in
  `scripts/ci/verify-changed.ts`.

History: docs/archive/agent-notes/packages-and-adapters.md
