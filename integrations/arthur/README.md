# Arthur Engine

Traces of what the coding agents did, continuous evaluation of those traces,
and a prompt-injection screen over untrusted text.

## Connecting it

Two values, and they are the two environment variables this product has always
read, so a deployment that had Arthur before this package existed keeps working
with nothing to do:

| Field | Variable | What it is |
|---|---|---|
| Trace endpoint | `GENAI_ENGINE_TRACE_ENDPOINT` | The full traces URL of your engine, ending in `/api/v1/traces`. The task API is read from the same host. |
| API key | `GENAI_ENGINE_API_KEY` | A key with access to that engine's tasks and traces. |

The endpoint is the full path rather than a base URL because the in-sandbox
tracer posts to it directly. Everything else (the task API at `/api/v2/tasks`)
is derived from the same host.

## What connecting it gives you

- **Traces.** Every agent sandbox the deployment provisions is handed the
  engine's tracer, so a run's prompts, tool calls and failures arrive as
  OpenInference spans. They land in one task per run, named after the ticket
  (`AWT-42`, then `AWT-42.1` for the next run of the same ticket).
- **The Evals tab.** The pass rate over the last 24 hours, the spans graded and
  the traces received. Grading itself is configured on the engine.
- **The Prompt injection check block.** Bind the text an agent is about to read
  and the block reports `ok` or `flagged`, with the findings behind the verdict.

## The injection check fails closed

It is a security control, so every uncertainty stops the run rather than
reporting a clean verdict:

- Nothing bound to `content`, or only whitespace: the block fails and says to
  bind what should be screened.
- No task on the engine: the block fails. Nothing screened the content.
- The engine evaluated no rule: `flagged`, with `reason:
  arthur_no_rules_evaluated`. A validation that ran no rule is not a pass.
- The engine refuses or cannot be reached: the block fails with its reason.
- Arthur disconnected or disabled: the run does not reach the block at all. It
  fails at dispatch with `integration_unavailable`, naming Arthur.

A deterministic local prefilter runs before the engine, so a blatant override
payload flags identically on every run whatever a probabilistic classifier
makes of it.

## What is in this package

| File | What it is |
|---|---|
| `manifest.ts` | Identity, the two connection fields, the block, the Evals page, the health check, and `runState` (this integration needs one task per run). |
| `worker.ts` | The connection test, the tracer handed to each sandbox, `beginRun`, the block, the health probe and what the Evals page reads. |
| `dashboard.tsx` | The Evals page, built on `@integrations/host-ui`. |
| `client.ts` | The slice of the engine's API this package uses, over `ctx.http`. |
| `injection-markers.ts` | The deterministic prefilter. |
| `tracer.generated.ts` | The engine's Python tracer, base64, as data. |
| `build-tracer.mjs` | Regenerates the file above from a checkout of `arthur-engine` beside the monorepo: `pnpm --filter @integrations/arthur run build:tracer`. |

## Upgrading the tracer

The tracer is generated from
`arthur-engine/integrations/claude-code/claude_code_tracer.py`. Check that
checkout out next to this monorepo, run the build script, and commit the
regenerated file. `ARTHUR_TRACER_SRC` overrides where it is read from.
