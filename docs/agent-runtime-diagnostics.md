# Agent runtime diagnostics

Sandboxed agent failures expose only a provider-neutral message and an
`AIW-DIAG-<run>-<node>-<attempt>` code. The internal provider details exist only
in the correlated worker log event `workflow_execution_error`.

## Diagnose a failed run

1. Copy the diagnostic ID from the run detail, notification, dashboard trace,
   or block tooltip.
2. Search worker logs for `workflow_execution_error` and that exact
   `diagnosticId`.
3. Check `nodeId`, `attempt`, `category`, and `phase` first. When the failure came
   from a pinned agent protocol, inspect `agentProtocol`:
   - `provider`, `packageName`, `cliVersion`, and `protocol` identify the runtime;
   - `failureKind`, `exitCode`, and `event` identify the failure boundary;
   - artifact byte counts and SHA-256 hashes let repeated failures be compared;
   - `schema.identity`, `schema.sha256`, and at most 20 issue paths/messages
     describe contract failures without retaining the schema or model value;
   - `stderrTail` is redacted and capped at 2 KiB; `stdoutTail` exists only when
     malformed protocol output could not be structurally parsed.

The logger must not contain prompts, full model responses, structured-output
values, generated source, full user schemas, or unredacted credentials. If
redaction cannot safely produce a tail, only metadata is logged.

## Safe messages

- Provisioning: `The agent runtime could not be prepared.`
- Process/provider failure: `The current agent phase could not be completed.`
- Parsing/schema failure: `The current agent phase returned an invalid structured response.`

These messages and the diagnostic ID are authoritative in telemetry, API, and
dashboard payloads. Protocol diagnostics are not persisted or returned by an
API.

## Pinned versions

- Claude: `@anthropic-ai/claude-code@2.1.216`, protocol `claude-json-2.1.216`
- Codex: `@openai/codex@0.144.6`, protocol `codex-jsonl-0.144.6`

Provisioning installs the exact package version, runs `<cli> --version`, and
rejects an unreadable or mismatched semantic version. There is no environment
override, retry, or fallback. A version change requires a reviewed edit to
`src/sandbox/agents/protocol.ts` and refreshed fixtures.

## Refresh fixtures and smoke-test

Normal CI uses credential-free fixtures in versioned provider directories. The
capture command creates a disposable Vercel Sandbox, installs and verifies the
source-controlled version, runs one harmless structured prompt and one harmless
freeform prompt, normalizes volatile fields, scans for secrets, and tears the
sandbox down in a `finally` block.

From `apps/worker`, with Vercel credentials plus the provider API key loaded:

```bash
pnpm capture:agent-protocol-fixtures -- --provider claude --env-file /secure/path/worker.env --write
pnpm capture:agent-protocol-fixtures -- --provider codex --env-file /secure/path/worker.env --write
```

Omit `--write` for a smoke test that prints only versions, artifact sizes, and
hashes. A secret-scan or protocol-validation failure refuses fixture writes.
Review the fixture diff, run the protocol fixture tests, and record only exact
versions plus sanitized success/failure metadata in the pull request.
