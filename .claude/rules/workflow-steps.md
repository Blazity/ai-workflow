---
paths:
  - "apps/worker/src/engine/agent-workflow.ts"
  - "apps/worker/src/engine/post-pr-gate-workflow.ts"
  - "apps/worker/src/engine/steps/**"
  - "apps/worker/src/engine/blocks/**"
---

# Workflow and step bodies

- `apps/worker/src/engine/agent-workflow.ts` is a Workflow DevKit `"use workflow"`
  module with NO top-level adapter or logger imports. Every use of `logger` or
  an adapter inside a `"use step"` is a deferred
  `await import("../infra/logger.js")` in the step body. Do not add a top-level
  import there, and do not assume a warm module is already imported at the top:
  the module is cache-warm only because an earlier step in the same run
  imported it.
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
