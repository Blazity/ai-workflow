# Replay sanitization preview canary

This is the rollout gate for persisted attempts and visual replay. It extends
the Harness Profile preview canary instead of adding a second dispatch path.
The first two cases still prove the built-in Claude and Codex profiles. The
custom-profile case additionally puts synthetic sensitive values in the Jira
ticket description and verifies the completed replay.

Run:

```sh
pnpm test:e2e:replay:dry
pnpm test:e2e:replay
```

The dry command validates the fixture and fail-closed evidence checks without
making network calls. The full command has the same guarded preview mutations,
fixtures, credentials, and restoration behavior as
`test:e2e:harness-profiles`; read
[`harness-profile-preview-canary.md`](./harness-profile-preview-canary.md)
before running it.

Do not mark the replay PR ready until the full command passes against the exact
reviewed HTTPS preview and its matching database branch.

## Additional runner environment

The replay command requires all Harness Profile canary variables plus:

```dotenv
# Exact protected dashboard preview. This may differ from the worker URL.
REPLAY_CANARY_DASHBOARD_BASE_URL=https://your-dashboard-preview.example
REPLAY_CANARY_DASHBOARD_EXPECTED_HOST=your-dashboard-preview.example
REPLAY_CANARY_DASHBOARD_AUTOMATION_BYPASS_SECRET=...

# An absolute local file receiving the reviewed preview's application/runtime
# logs. It must already exist and be actively appended while the canary runs.
REPLAY_CANARY_LOG_EXPORT_PATH=/absolute/path/replay-preview-canary.log

# Optional. Defaults: 120 seconds, 15 seconds, and 32 MiB.
REPLAY_CANARY_LOG_WAIT_MS=120000
REPLAY_CANARY_LOG_SETTLE_MS=15000
REPLAY_CANARY_LOG_MAX_BYTES=33554432
```

Before starting the canary:

1. Create or truncate `REPLAY_CANARY_LOG_EXPORT_PATH`.
2. Start the platform's authenticated log exporters for the exact worker
   runtime and dashboard preview under review. Append both streams to that
   file. Include application/runtime and request logs.
3. Confirm the exporters are still running, then invoke
   `pnpm test:e2e:replay`.
4. Stop the exporters after the command exits.

The runner records the file offset before changing preview state and inspects
only bytes appended after that point. It requires the completed run ID to
appear, waits for the file size to settle, bounds the scan, and rejects
truncation, invalid UTF-8, missing coverage, or an unavailable file. It never
prints the injected values or failed response bodies.

## Checks performed

The custom-profile case uses the existing deployed v2
`trigger_ticket_ai -> generic_agent` fixture with `workspaceMode: "none"`.
It injects unique synthetic examples of a token, email, phone number, payment
card, IBAN, and authorization header through the ticket description. The
fixture cannot write a repository, open a pull request, or invoke a
canary-only endpoint.

After the run succeeds, the command requires:

- an available replay snapshot and terminal attempt summaries from the
  authenticated worker API;
- a lazy-loaded detail for every returned attempt and at least one captured log
  envelope;
- the expected redaction metadata for every injected sensitive-data class;
- the raw `workflow_run_observations` row and every
  `workflow_block_attempts` row from the exact preview database;
- a server-rendered `/trace/<runId>` response from the authenticated dashboard
  containing the visual replay canvas; and
- an operator-supplied application/runtime log export that contains the exact
  run ID and settles after completion.

The command serializes and scans the database rows, replay summary and detail
responses, rendered dashboard HTML, and appended logs. Any exact injected
value on any surface fails the gate.

## Explicit limitations

- The command cannot obtain deployment logs itself without expanding its
  credentials and mutation surface. An operator must provide the live combined
  export; a missing or unscoped export fails closed.
- The dashboard check covers its server-rendered trace. Browser hydration and
  screenshots remain separate UI evidence.
- The canary proves the reviewed preview and database branch only. It is not a
  production mutation and does not enable the feature flag.
- A process kill can still prevent the Harness Profile canary's `finally`
  restoration. Follow the manual restoration procedure in the Harness Profile
  canary document before retrying.
