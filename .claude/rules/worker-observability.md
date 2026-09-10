---
paths:
  - "apps/worker/src/services/**"
  - "apps/worker/src/run-observability/**"
  - "apps/worker/src/routes/api/v1/runs**"
---

# Logging and run telemetry

- Pino's error serializer applies to the `err` key only.
  `logger.warn({ error: err }, ...)` stringifies an Error to `{}`, because
  message and stack are non-enumerable. The convention here is
  `logger.warn({ err: (err as Error).message }, "msg")`.
- The Workflow `/v2/runs` list API caps `limit` at 100. A larger limit returns
  400, which surfaces as a thrown `WorkflowWorldError` and, when caught, as a
  null KPI and an "N/A" tile. Keep any `world.runs.list` limit at or below 100.
- Read runs and steps with `resolveData: 'none'`. Step `input` and `output` are
  encrypted at rest and are not decrypted on read, so a trace shows step I/O as
  not viewable; parse step labels with `parseStepName(name).functionName`.
- Tokens, cost, eval scores, sandbox results and PR diffs are not available
  from the Workflow run store. They come from the telemetry tables this
  repository writes.
