---
paths:
  - "apps/worker/src/engine/**"
  - "apps/worker/workflow-test-fixtures/**"
---

# Workflow and step bodies

- Keep every production `"use step"` and `"use workflow"` file under
  `apps/worker/src/engine/`, because the Workflow DevKit discovers directives
  from file content rather than imports. A file outside the builder scan fails
  only at runtime with `is not registered in the current deployment`. A stray
  backtick in a comment can hide every directive below it. Guards:
  `apps/worker/src/engine/workflow-import-boundary.test.ts` and
  `apps/worker/src/engine/step-registration-coverage.test.ts`.
- Import worker source from `apps/worker/workflow-test-fixtures/` without a
  file extension, for example `../../src/foo`. A `.js` suffix is resolved
  literally, can drop the import chain from the builder graph, and can make
  `(cd apps/worker && pnpm run test:workflow-sdk)` time out with
  `Cannot find module .../packages/<name>/<file>`.
- `apps/worker/src/engine/agent-workflow.ts` is the `"use workflow"` module and
  imports no adapter or logger at the top (adapter types only). It loads step
  modules with a deferred `await import(...)`, and a step body loads the logger
  inside the body, as `engine/steps/phase.ts` does. Keep both deferred: a module
  is warm only because an earlier step in the same run imported it.
- A step that "never throws" is only safe together with `maxRetries = 0` and a
  failure mode that does not affect the run outcome, because the deferred
  import inside its `catch` can itself fail cold.
- Do not swallow telemetry failures. Use `.catch((err) => console.error(...))`
  rather than `.catch(() => {})`, so a future schema drift surfaces in logs
  immediately instead of silently dropping run history for days.
  `console.error` is fine in workflow scope.
- `"use workflow"` bodies run sandboxed and must be deterministic. Side
  effects, database clients and network calls belong in `"use step"` bodies,
  which have full Node access.

History: docs/archive/agent-notes/worker-runtime.md
