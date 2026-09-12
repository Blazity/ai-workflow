Status: current
Last-verified: 2026-09-12

# workflow-graph-suites

These suites exercise `@shared/workflow-graph` through the worker's bindings:
the ajv-backed `WorkflowJsonSchemaSupport`, the block registry and block
contract resolver, and the scheduler dependencies. The rules they cover live in
the package; what they prove is that the package still answers the same way once
the worker's data is bound to it, which is a question the package's own
`node:test` smoke file cannot ask.

They stay in the worker for that reason, on vitest, with their expectations
untouched by the moves (stage 12 of the workflow-graph plan, rows 4 to 7). They
use `expect`, `toMatchObject`, `it.each` and the 15 s timeout, none of which
`node:test` offers without weakening the assertions.

`scenarios/` is the corpus: each scenario runs the production scheduler over a
published graph (a built-in template, or a committed snapshot under
`scenarios/snapshots/`). `scenarios/harness.ts` is the runner and the recorder
behind `scenarios/scheduling.golden.json`; `scenarios/scheduling-golden.test.ts`
asserts that fixture. Re-record it only when an order was meant to change:

```sh
pnpm --filter worker run capture:scheduling-golden -- --write
```

`scripts/ci/verify-changed.ts` lists these files in `WORKFLOW_GRAPH_TESTS`, so a
change under `packages/workflow-graph/` plans them.
