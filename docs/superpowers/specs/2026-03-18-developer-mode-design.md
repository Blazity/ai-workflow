# Developer Mode: Live Container Inspection

## Problem

When Blazebot sandbox containers run Claude Code agents, the agent's activity is invisible during execution. Claude Code runs with `--print` mode, which outputs a single JSON blob at the end. There is no way to observe what the agent is doing in real-time via `docker logs -f`.

Developers need to inspect live agent activity inside containers — tool calls, file edits, assistant reasoning — to debug issues and understand agent behavior.

## Solution

Introduce a `DEVELOPER_MODE` environment variable that switches Claude Code's output format from `--print` (single final JSON) to `--print --output-format stream-json` (newline-delimited JSON events streamed in real-time). A lightweight formatter script makes the stream human-readable via `docker logs -f`.

## Developer Workflow

1. Set `DEVELOPER_MODE=true` in `.env`
2. Run `pnpm dev`
3. Trigger a job (e.g. via Jira webhook)
4. Run `pnpm inspect` — lists running Blazebot containers, lets you pick one, and attaches to its logs

### Inspect Script (`scripts/inspect.sh`)

A convenience script exposed as `pnpm inspect` that:

1. Queries `docker ps --filter label=blazebot=true --format` to list running sandbox containers
2. Displays a numbered list showing each container's branch name (from `blazebot.branch` label), status, and how long it's been running
3. If only one container is running, attaches to it automatically
4. If multiple containers are running, prompts the user to pick one by number
5. If no containers are running, prints a message and exits
6. Attaches via `docker logs -f <container_id>` to stream live output

Example output:

```
Blazebot sandbox containers:

  1) blazebot/PROJ-42  (Up 2 minutes)
  2) blazebot/PROJ-58  (Up 30 seconds)

Select container [1-2]: 1
Attaching to blazebot/PROJ-42 ...
[12:34:05] tool_use: Edit(src/index.ts)
[12:34:06] tool_result: success
...
```

The script requires no dependencies beyond `docker` CLI. It uses basic bash and `docker ps` formatting.

## Design

### Environment Variable

Add `DEVELOPER_MODE` to `src/env.ts` as a boolean (default `false`):

```ts
DEVELOPER_MODE: z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true"),
```

The sandbox manager passes it into the container's env array so the entrypoint script can read it.

### Container Labels

Add a `blazebot.branch` label to created containers (alongside the existing `blazebot=true`) with the branch name. This makes it easy to identify specific containers when multiple agents run concurrently:

```bash
docker ps --filter label=blazebot.branch=blazebot/PROJ-42
```

### Entrypoint Branching

`docker/sandbox/entrypoint.sh` conditionally invokes Claude Code:

- **Production** (`DEVELOPER_MODE` unset or `false`): `claude --print --output-format json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions` — current behavior, single JSON result at exit.
- **Developer mode** (`DEVELOPER_MODE=true`): `claude --print --verbose --output-format stream-json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions | /opt/blazebot/format-stream.sh` — real-time structured events piped through a formatter.

Both modes use `--print` to ensure single-run-and-exit behavior. The `--output-format` flag controls serialization format only.

**Exit code propagation:** The entrypoint already sets `set -euo pipefail`. With `pipefail`, the pipeline returns the rightmost non-zero exit code, so Claude's exit code propagates correctly through the pipe. The formatter must handle malformed lines gracefully (never exit non-zero on parse errors) to avoid masking Claude's exit code.

### Stream Formatter

New file `docker/sandbox/format-stream.sh`. Uses `jq` (already in the Docker image) to parse each stream-json line and output human-readable, timestamped log lines:

```
[12:34:05] tool_use: Edit(src/index.ts)
[12:34:06] tool_result: success
[12:34:07] assistant: "Now I'll update the tests..."
[12:34:12] result: implemented
```

**Error resilience:** The formatter uses per-line error handling so that non-JSON lines (e.g. warnings from Claude Code) are passed through as-is rather than crashing the script. This is critical for exit code propagation via `pipefail`.

**Result passthrough:** For `result`-type events, the formatter outputs the human-readable line AND the raw JSON line (in that order). Since `parseAgentOutput` scans backwards and skips lines not starting with `{`, the human-readable line is ignored and the JSON line is found. The raw JSON line is always emitted last for any given event, ensuring correct backward-scan ordering.

### Result Parsing Compatibility

`parseAgentOutput` in `src/sandbox/manager.ts` scans stdout backwards for a JSON line with the result. Both output modes produce compatible result envelopes:

- `--print --output-format json`: `{ "type": "result", "structured_output": { "result": "implemented", ... } }`
- `--print --output-format stream-json`: Multiple JSON lines, the last `result` event contains `{ "type": "result", "subtype": "success", "structured_output": { "result": "implemented", ... } }`

Both shapes are already handled by the existing parsing logic — it checks `structured_output` first, then falls back to the `result` field.

**Note:** The exact shape of the `stream-json` result event should be verified during implementation by running `claude --print --output-format stream-json` manually and inspecting the output. If the shape differs, `parseAgentOutput` will need adjustment.

**Memory consideration:** In developer mode, stdout will contain many more lines (every stream event plus formatter output). The entire log is buffered into a string via `readAllContainerLogs`. For long agent runs this could be large but is not a correctness concern — just worth noting.

## Files Changed

| File | Change |
|---|---|
| `src/env.ts` | Add `DEVELOPER_MODE` boolean env var (default `false`) |
| `src/sandbox/manager.ts` | Pass `DEVELOPER_MODE` into container env array; add `blazebot.branch` label |
| `src/sandbox/manager.test.ts` | Update test assertions for new env var in `Env` array and new label |
| `docker/sandbox/entrypoint.sh` | Conditional invocation: `stream-json` + formatter in dev mode, `--print` in production |
| `docker/sandbox/format-stream.sh` | New — `jq`-based formatter for human-readable stream output, passes through result JSON for `result` events |
| `docker/sandbox/Dockerfile` | Copy and chmod `format-stream.sh` |
| `scripts/inspect.sh` | New — interactive container picker + `docker logs -f` attachment |
| `package.json` | Add `"inspect": "bash scripts/inspect.sh"` script |
| `.env.example` | Add `DEVELOPER_MODE=false` entry |

## Out of Scope

- Multi-container log aggregation (prefix by ticket ID, interleaving) — future work if needed
- Web UI for log viewing
- Persisting agent logs to database
- Tee raw JSON to a file for post-mortem analysis (future enhancement)
