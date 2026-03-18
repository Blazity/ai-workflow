# Developer Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow developers to inspect live Claude Code agent output inside Docker sandbox containers via `docker logs -f`, toggled by a `DEVELOPER_MODE` env var.

**Architecture:** A `DEVELOPER_MODE` env var propagates from the orchestrator into sandbox containers. When true, the entrypoint switches Claude Code to `stream-json` output, piped through a `jq`-based formatter for human-readable logs. A `pnpm inspect` convenience script lists containers and attaches to one.

**Tech Stack:** Bash, jq, dockerode, Zod, vitest

**Spec:** `docs/superpowers/specs/2026-03-18-developer-mode-design.md`

---

### Task 1: Add `DEVELOPER_MODE` env var

**Files:**
- Modify: `src/env.ts:4-61`
- Modify: `.env.example:44-51`

- [ ] **Step 1: Add `DEVELOPER_MODE` to the Zod schema in `src/env.ts`**

Add after the `SANDBOX_MEMORY_MB` entry (line 58), before the closing brace:

```ts
    DEVELOPER_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
```

- [ ] **Step 2: Add `DEVELOPER_MODE` to `.env.example`**

Add under the `# Sandbox config` section, after `SANDBOX_MEMORY_MB=4096`:

```
# Developer mode (streams Claude Code output for docker logs -f inspection)
DEVELOPER_MODE=false
```

- [ ] **Step 3: Verify the build**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm build`
Expected: Compiles successfully with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/env.ts .env.example
git commit -m "feat: add DEVELOPER_MODE env var"
```

---

### Task 2: Pass `DEVELOPER_MODE` into containers and add branch label

**Files:**
- Modify: `src/sandbox/manager.ts:7-17` (SandboxOptions interface)
- Modify: `src/sandbox/manager.ts:99-113` (createContainer call)

- [ ] **Step 1: Add `developerMode` to `defaultOptions` in tests**

In `src/sandbox/manager.test.ts`, add to `defaultOptions` (after `memoryLimitMb` on line 63):

```ts
    developerMode: false,
```

- [ ] **Step 2: Add `developerMode` to `SandboxOptions` interface**

In `src/sandbox/manager.ts`, add to the `SandboxOptions` interface (after `memoryLimitMb` on line 17):

```ts
  developerMode: boolean;
```

- [ ] **Step 3: Pass `DEVELOPER_MODE` and branch label in `createContainer`**

In `src/sandbox/manager.ts`, update the `createContainer` call in `runSandbox` (lines 99-113).

Change the `Labels` object from:

```ts
      Labels: { blazebot: "true" },
```

to:

```ts
      Labels: { blazebot: "true", "blazebot.branch": options.branchName },
```

Add to the `Env` array after the `CLAUDE_MODEL` line:

```ts
        `DEVELOPER_MODE=${options.developerMode}`,
```

- [ ] **Step 4: Update existing label test assertion**

The existing test `"labels containers with blazebot=true"` (line 222-234) asserts `Labels: { blazebot: "true" }`. Update it to include the new label:

```ts
    expect(createContainerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: { blazebot: "true", "blazebot.branch": "blazebot/PROJ-42" },
      }),
    );
```

- [ ] **Step 5: Write the new tests**

Add to `src/sandbox/manager.test.ts` after the existing `"labels containers with blazebot=true"` test (line 234):

```ts
  it("passes DEVELOPER_MODE into container env", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

    await runSandbox({ ...defaultOptions, developerMode: true });

    expect(createContainerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Env: expect.arrayContaining([
          "DEVELOPER_MODE=true",
        ]),
      }),
    );
  });

  it("adds blazebot.branch label to container", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

    await runSandbox(defaultOptions);

    expect(createContainerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: {
          blazebot: "true",
          "blazebot.branch": "blazebot/PROJ-42",
        },
      }),
    );
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm vitest run src/sandbox/manager.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Verify the build**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm build`
Expected: Compiles successfully. Note: the caller in `worker.ts` will fail at this point because it doesn't pass `developerMode` yet — that's expected and fixed in the next step.

- [ ] **Step 8: Update both callers in `worker.ts`**

There are two `runSandbox` call sites in `src/worker.ts` that both need `developerMode: env.DEVELOPER_MODE` added to the options object:

1. In `handleImplementation` (around line 167)
2. In `handleReviewFix` (around line 360)

Add `developerMode: env.DEVELOPER_MODE,` to both options objects.

- [ ] **Step 9: Verify the build again**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm build`
Expected: Compiles successfully with no errors.

- [ ] **Step 10: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts src/worker.ts
git commit -m "feat: pass DEVELOPER_MODE into containers, add branch label"
```

---

### Task 3: Create the stream formatter script

**Files:**
- Create: `docker/sandbox/format-stream.sh`

- [ ] **Step 1: Create `docker/sandbox/format-stream.sh`**

```bash
#!/bin/bash
# format-stream.sh — Formats Claude Code stream-json output for human-readable docker logs.
# Reads newline-delimited JSON from stdin, outputs timestamped human-readable lines.
# For "result" events, also passes through the raw JSON so parseAgentOutput can find it.
# Handles non-JSON lines gracefully (passes them through as-is).

while IFS= read -r line; do
  # Try to parse as JSON; if it fails, pass through as-is
  parsed=$(echo "$line" | jq -r '
    if type != "object" then
      empty
    elif .type == "assistant" then
      "assistant: " + (
        if (.content // null) != null then
          (.content | if type == "array" then (map(if .text then .text else (. | tostring) end) | join("")) else tostring end | .[0:200])
        else
          "(message)"
        end
      )
    elif .type == "tool_use" then
      "tool_use: " + (.name // "unknown") + "(" + ((.input // {} | keys | join(", ")) // "") + ")"
    elif .type == "tool_result" then
      "tool_result: " + (if .is_error then "ERROR" else "ok" end)
    elif .type == "result" then
      "result: " + (.structured_output.result // .subtype // "unknown")
    else
      .type
    end
  ' 2>/dev/null)

  ts=$(date +"%H:%M:%S")

  if [ -n "$parsed" ]; then
    echo "[$ts] $parsed"
    # For result events, also emit the raw JSON for parseAgentOutput
    is_result=$(echo "$line" | jq -r 'if .type == "result" then "yes" else "no" end' 2>/dev/null)
    if [ "$is_result" = "yes" ]; then
      echo "$line"
    fi
  else
    # Non-JSON line or unrecognized — pass through with timestamp
    echo "[$ts] $line"
  fi
done
```

- [ ] **Step 2: Make it executable locally**

Run: `chmod +x /Users/kacper/Desktop/blazity/ai-workflow/docker/sandbox/format-stream.sh`

- [ ] **Step 3: Test the formatter manually**

Run:
```bash
echo '{"type":"tool_use","name":"Edit","input":{"file":"src/index.ts"}}
{"type":"tool_result","is_error":false}
{"type":"assistant","content":[{"text":"Now updating tests..."}]}
{"type":"result","subtype":"success","structured_output":{"result":"implemented","summary":"Done"}}
not json at all' | /Users/kacper/Desktop/blazity/ai-workflow/docker/sandbox/format-stream.sh
```

Expected output (timestamps will vary):
```
[HH:MM:SS] tool_use: Edit(file)
[HH:MM:SS] tool_result: ok
[HH:MM:SS] assistant: Now updating tests...
[HH:MM:SS] result: implemented
{"type":"result","subtype":"success","structured_output":{"result":"implemented","summary":"Done"}}
[HH:MM:SS] not json at all
```

Verify: the raw JSON line for the result event appears after the formatted line, and non-JSON input is passed through without error.

- [ ] **Step 4: Commit**

```bash
git add docker/sandbox/format-stream.sh
git commit -m "feat: add stream formatter script for developer mode"
```

---

### Task 4: Update entrypoint for conditional output mode

**Files:**
- Modify: `docker/sandbox/entrypoint.sh:18-29`

- [ ] **Step 1: Update the Claude Code invocation in `docker/sandbox/entrypoint.sh`**

Replace lines 24-29 (from `CLAUDE_EXIT=0` to `exit $CLAUDE_EXIT`) with:

```bash
CLAUDE_EXIT=0
if [ "${DEVELOPER_MODE:-false}" = "true" ]; then
  echo "Developer mode enabled — streaming structured output" >&2
  claude --print --verbose --output-format stream-json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions < /workspace/requirements.md | /opt/blazebot/format-stream.sh || CLAUDE_EXIT=$?
else
  claude --print --output-format json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions < /workspace/requirements.md || CLAUDE_EXIT=$?
fi

echo "Claude Code exited with code: $CLAUDE_EXIT" >&2

exit $CLAUDE_EXIT
```

- [ ] **Step 2: Verify the entrypoint syntax**

Run: `bash -n /Users/kacper/Desktop/blazity/ai-workflow/docker/sandbox/entrypoint.sh`
Expected: No output (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add docker/sandbox/entrypoint.sh
git commit -m "feat: switch to stream-json output in developer mode"
```

---

### Task 5: Update Dockerfile to include formatter

**Files:**
- Modify: `docker/sandbox/Dockerfile:10-13`

- [ ] **Step 1: Add `format-stream.sh` to the Dockerfile**

In `docker/sandbox/Dockerfile`, update the COPY and chmod section. Change lines 10-13 from:

```dockerfile
COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
COPY commit-guard.sh /opt/blazebot/commit-guard.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/git /opt/blazebot/commit-guard.sh
```

to:

```dockerfile
COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
COPY commit-guard.sh /opt/blazebot/commit-guard.sh
COPY format-stream.sh /opt/blazebot/format-stream.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/git /opt/blazebot/commit-guard.sh /opt/blazebot/format-stream.sh
```

- [ ] **Step 2: Commit**

```bash
git add docker/sandbox/Dockerfile
git commit -m "feat: include format-stream.sh in sandbox image"
```

---

### Task 6: Create the inspect convenience script

**Files:**
- Create: `scripts/inspect.sh`
- Modify: `package.json:8-16` (scripts section)

- [ ] **Step 1: Create `scripts/` directory and `scripts/inspect.sh`**

Run: `mkdir -p /Users/kacper/Desktop/blazity/ai-workflow/scripts`

```bash
#!/bin/bash
set -euo pipefail

# inspect.sh — Lists running Blazebot sandbox containers and attaches to one.

containers=$(docker ps --filter label=blazebot=true --format '{{.ID}}\t{{.Label "blazebot.branch"}}\t{{.Status}}' 2>/dev/null)

if [ -z "$containers" ]; then
  echo "No running Blazebot containers found."
  echo "Make sure DEVELOPER_MODE=true is set and a job is running."
  exit 0
fi

# Read into arrays
ids=()
branches=()
statuses=()
while IFS=$'\t' read -r id branch status; do
  ids+=("$id")
  branches+=("${branch:-unknown}")
  statuses+=("$status")
done <<< "$containers"

count=${#ids[@]}

echo ""
echo "Blazebot sandbox containers:"
echo ""
for i in "${!ids[@]}"; do
  idx=$((i + 1))
  echo "  ${idx}) ${branches[$i]}  (${statuses[$i]})"
done
echo ""

if [ "$count" -eq 1 ]; then
  selected=0
  echo "Auto-attaching to ${branches[0]} ..."
else
  read -rp "Select container [1-${count}]: " choice
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
    echo "Invalid selection."
    exit 1
  fi
  selected=$((choice - 1))
  echo "Attaching to ${branches[$selected]} ..."
fi

echo ""
docker logs -f "${ids[$selected]}"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x /Users/kacper/Desktop/blazity/ai-workflow/scripts/inspect.sh`

- [ ] **Step 3: Add `inspect` script to `package.json`**

In `package.json`, add a trailing comma to the `"db:push"` line and add the new script after it:

Change:
```json
    "db:push": "drizzle-kit push"
```

To:
```json
    "db:push": "drizzle-kit push",
    "inspect": "bash scripts/inspect.sh"
```

- [ ] **Step 4: Test the script with no containers running**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && bash scripts/inspect.sh`
Expected:
```
No running Blazebot containers found.
Make sure DEVELOPER_MODE=true is set and a job is running.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/inspect.sh package.json
git commit -m "feat: add pnpm inspect script for container log inspection"
```

---

### Task 7: Verify end-to-end (manual)

- [ ] **Step 1: Rebuild the sandbox Docker image**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && docker build -t blazebot-sandbox docker/sandbox/`
Expected: Image builds successfully.

- [ ] **Step 2: Run all tests**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm vitest run`
Expected: All tests pass.

- [ ] **Step 3: Run the build**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm build`
Expected: Compiles with no errors.

- [ ] **Step 4: Verify stream-json output format**

Before relying on the implementation in production, manually verify that `claude --print --output-format stream-json` produces the expected result envelope shape. If the shape differs from what `parseAgentOutput` expects, adjust the parser accordingly.

- [ ] **Step 5: Commit (if any adjustments were needed)**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end verification"
```
