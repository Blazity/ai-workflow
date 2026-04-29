# Codex Integration — Design

**Date:** 2026-04-27
**Status:** Draft
**Branch:** AIW-1-codex

## Goal

Add OpenAI's Codex CLI (`@openai/codex`) as a second agent runtime alongside Claude Code. Operators choose at deploy time via `AGENT_KIND=claude|codex`. Both agents reach full feature parity for the existing three-phase workflow (research → impl → review): same skills, same commit-guard, same Arthur tracing, same structured output, same usage reporting. The change introduces a thin `AgentAdapter` abstraction and refactors the sandbox layer to use it; everything else (workflow orchestration, VCS, issue tracker, messaging, run registry, reconcile, dispatch) is untouched.

## Decisions

| Question | Decision |
|----------|----------|
| Replace Claude or add Codex alongside? | **Add alongside**, env-switched |
| Switching mechanism | `AGENT_KIND=claude\|codex` env var (single, deploy-scoped) |
| Gap-fill strategy | **Full parity** — skills, hooks, structured output, tracing all reach Codex |
| Codex variant | `@openai/codex` CLI |
| Phase parity | Same three phases for both agents |
| Default Codex model | `gpt-5-codex` |
| Architecture | Thin `AgentAdapter` interface in `src/sandbox/agents/` |
| Skills location | `~/.agents/skills/` only — never in the repo |
| Pricing | Fetched dynamically from LiteLLM's maintained JSON; tokens-only fallback |

## Architecture

A new `AgentAdapter` interface owns everything CLI-specific. `SandboxManager` becomes thin and orchestrator-only. Workflow code (`src/workflows/agent.ts`) threads the adapter through phase steps but otherwise keeps its current shape.

```ts
// src/sandbox/agents/types.ts
export type PhaseKind = "research" | "impl" | "review";

export interface AgentAdapter {
  kind: "claude" | "codex";
  install(sandbox: RunnableSandbox): Promise<void>;
  configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void>;
  setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void>;
  buildPhaseScript(opts: PhaseScriptOpts): string;
  artifactPaths(phase: PhaseKind): {
    wrapper: string;
    input: string;
    stdout: string;
    stderr: string;
    sentinel: string;
    /** Schema-validated JSON file (Codex --output-schema). null for Claude. */
    structuredOutput: string | null;
  };
  parseAgentOutput(raw: string, structured: string | null): AgentOutput;
  parseReviewOutput(raw: string, structured: string | null): ReviewOutput;
  parseResearchStatus(raw: string, structured: string | null): ResearchResult;
  extractUsage(raw: string, structured: string | null): PhaseUsage | null;
}
```

The Claude adapter ignores the `structured` argument in every parser — Claude embeds its schema-validated output directly in the NDJSON stream, so `paths.structuredOutput` is `null` and only `raw` matters. The Codex adapter prefers `structured` when present and falls back to `raw` (NDJSON `item.completed` scan) when the schema file is missing. The unified signature lets the workflow stay agent-agnostic.

`createAgentAdapter(env)` picks the implementation at startup based on `AGENT_KIND`. Required credentials are validated by `env.ts` cross-field rules — if `AGENT_KIND=codex` is set without `CODEX_API_KEY` (or `CODEX_CHATGPT_OAUTH_TOKEN`), the server fails fast at startup.

## File Layout

```text
src/sandbox/
  agents/
    types.ts              # AgentAdapter interface, shared types
    claude.ts             # Existing Claude logic, refactored into the adapter
    codex.ts              # New: codex exec wrapper, hooks.json, --output-schema parsing
    shared.ts             # GLOBAL_SKILLS, commit-guard script body, hook helpers
    pricing.ts            # fetchModelPrice(model) — LiteLLM-backed, TTL-cached
    index.ts              # createAgentAdapter(env) factory
    claude.test.ts
    codex.test.ts
    pricing.test.ts
    index.test.ts
  manager.ts              # Slimmed: provision() calls agent.install + agent.configure
  poll-agent.ts           # Adds collectPhase helper (raw + structured)
  context.ts              # Unchanged
  attachments.ts          # Unchanged
  usage.ts                # PhaseUsage type moves to agents/types.ts; formatUsageReport accepts a price lookup
```

Files **deleted** as part of the refactor:
- `src/sandbox/wrapper-script.ts` — body moves into each adapter's `buildPhaseScript`
- `src/sandbox/agent-runner.ts` — schema constants and parsers move into the adapters; if the file ends up empty it is deleted

Functions **replaced** as part of the refactor:
- `configureStopHookInSandbox` (currently in `manager.ts`) → becomes `agent.setCommitGuard(sandbox, enabled)` on the adapter. The standalone export is removed; `workflows/agent.ts` calls it through the adapter.
- `installArthurTracer` (currently in `manager.ts`, Claude-shaped) → moves into each adapter's `configure()` step. Claude installs to `~/.claude/`; Codex installs to `~/.codex/` with a Codex-shaped `hooks.json`.
- The free `buildPhaseScript` import in `workflows/agent.ts` → becomes `agent.buildPhaseScript(...)` calls.

Files **untouched**: `src/adapters/**`, `src/lib/**`, `src/routes/**`, `src/workflows/prompts-step.ts`, `src/workflows/prompts-step.test.ts`, all of the issue-tracker / VCS / messaging / run-registry code.

## Data Flow per Ticket (Codex)

```text
1. Cron poll → dispatch (unchanged)
2. agentWorkflow(ticketId)
   a. fetchAndValidateTicket / fetchPRContext / fetchAttachments / ensureArthurTaskForTicket (unchanged)
   b. provisionSandbox:
      - SandboxManager.provision(branch, mergeBase) clones the repo (unchanged)
      - Constructs the adapter via createAgentAdapter(env) → CodexAgentAdapter
      - agent.install(sandbox) → npm i -g @openai/codex
      - agent.configure(sandbox, { auth, model, arthur, arthurTaskId }):
          · Writes /tmp/agent-env.sh exporting CODEX_API_KEY (or OAuth token)
          · Writes ~/.codex/config.toml (model, sandbox profile, fallback file names)
          · Installs the global skill set into ~/.agents/skills/
          · Writes ~/.codex/hooks.json with Arthur PreToolUse/PostToolUse/UserPromptSubmit/Stop entries
          · Drops ~/.codex/hooks/commit-guard.sh on disk (Codex-flavored JSON output)
   c. registerTicketSandbox (unchanged)
3. PHASE 1 (Research):
   - agent.setCommitGuard(sandbox, false)
   - paths = agent.artifactPaths("research")
   - script = agent.buildPhaseScript({ phase: "research", model, ...paths })
   - writeAndStartPhase(sandboxId, paths.input, researchInput, paths.wrapper, script)
   - pollUntilDone(sandboxId, paths.sentinel, 20)
   - { raw, structured } = collectPhase(sandboxId, paths)
   - phaseUsages.Research = agent.extractUsage(raw, structured)
   - research = agent.parseResearchStatus(raw, structured)
4. PHASE 2 (Impl):
   - agent.setCommitGuard(sandbox, true)
   - script = agent.buildPhaseScript({ phase: "impl", ..., jsonSchema: AGENT_SCHEMA })
   - same write/poll/collect flow
   - implOutput = agent.parseAgentOutput(raw, structured)
5. PHASE 3 (Review): same wiring as Phase 2 (currently disabled in workflow)
6. Push + PR (unchanged)
7. Teardown (unchanged)
```

The Claude flow is the same with `paths.structuredOutput === null` and the existing parsers; behavior is bit-compatible with what Blazebot does today.

## Auth, Models, Env Config

**New env vars (added to `env.ts`):**

```ts
AGENT_KIND: z.enum(["claude", "codex"]).default("claude"),

// Codex auth — at least one required when AGENT_KIND=codex.
CODEX_API_KEY: z.string().min(1).optional(),
CODEX_CHATGPT_OAUTH_TOKEN: z.string().min(1).optional(),

// Codex model selection.
CODEX_MODEL: z.string().default("gpt-5-codex"),

// Pricing — LiteLLM's community-maintained JSON. Operators in airgapped
// environments override; default works for the common case.
CODEX_PRICING_URL: z.string().url().default(
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
),
CODEX_PRICING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
```

**Cross-field validation** (next to the existing `VCS_KIND` check in `env.ts`):

```ts
if (env.AGENT_KIND === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
  throw new Error("AGENT_KIND=codex requires CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN");
}
if (env.AGENT_KIND === "claude" && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
  throw new Error("AGENT_KIND=claude requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
}
```

Existing `CLAUDE_MODEL` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` keep their Claude-specific names — they are a public contract for current operators. We do not rename to a generic `AGENT_MODEL` / `AGENT_API_KEY`; agent-scoped names are clearer.

**`.env.example` additions:**

```bash
# Agent (claude | codex)
AGENT_KIND=claude

# Codex (only when AGENT_KIND=codex)
CODEX_API_KEY=
CODEX_CHATGPT_OAUTH_TOKEN=    # alternative to CODEX_API_KEY
CODEX_MODEL=gpt-5-codex
```

**README** gets a short "Agent" subsection covering: how to switch, which envs are required for each kind, and a pointer to the LiteLLM JSON for the model pricing data we use.

## Skills Strategy

**Single source of truth: `~/.agents/skills/` inside the sandbox.** Both agents read from there. We never write to or read from the repo's own `.agents/skills/` directory.

**Adapter steps in `configure()`:**

- Both adapters call a shared helper `installSkillsToAgentsDir(sandbox)` which runs `npx -y skills add <repo> --skill <skill> --yes --target ~/.agents/skills` for each entry in `GLOBAL_SKILLS`.
- The Claude adapter additionally creates the symlink `~/.claude/skills → ~/.agents/skills` so Claude's auto-discovery finds the same content.
- The Codex adapter does nothing extra — `~/.agents/skills/` is its native user-scope path.

**`shared.ts` exports:**

```ts
export const GLOBAL_SKILLS = [
  { repo: "https://github.com/obra/superpowers", skill: "using-superpowers" },
  { repo: "https://github.com/obra/superpowers", skill: "requesting-code-review" },
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
] as const;

export async function installSkillsToAgentsDir(sandbox: RunnableSandbox): Promise<void>;
```

The skill-frontmatter format (`name`, `description`) is identical for both agents. Existing prompts in `src/lib/prompts.ts` reference skills by name only and never mention agent-specific paths or Claude/Codex by name — they work as-is.

**Verification before shipping:** confirm the `skills` CLI accepts the `--target` flag against the version Blazebot installs. If not, fall back to installing into `~/.claude/skills/` and symlinking `~/.agents/skills → ~/.claude/skills` for Codex. Same outcome either direction.

## Hooks: Commit-guard + Arthur Tracing for Codex

Codex's hook system is shaped almost identically to Claude's: same event names (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`), same `command`-type entries, JSON in/out protocol. The differences:

| | Claude | Codex |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.codex/hooks.json` |
| Stop signal | `{"decision":"block","reason":"..."}` to stderr + exit 2 | `{"continue":false,"stopReason":"..."}` to stdout + exit 0 |
| Continue signal | exit 0 / no output | `{"continue":true}` or exit 0 / no output |

**Commit-guard for Codex:**

```bash
# ~/.codex/hooks/commit-guard.sh
#!/bin/bash
input=$(cat)
if echo "$input" | grep -q '"already_blocked":true'; then echo '{"continue": true}'; exit 0; fi
changes=$(git status --porcelain | grep -v '^.. \.codex/' | grep -v '^?? \.codex/')
if [ -n "$changes" ]; then
  printf '{"continue": false, "stopReason": "You have uncommitted changes. Commit them with a descriptive message or revert before stopping."}\n'
  exit 0
fi
echo '{"continue": true}'
```

Registered in `~/.codex/hooks.json` under `Stop`. `agent.setCommitGuard(sandbox, true|false)` upserts/removes the entry — keyed on the script path so other tools' hooks (Arthur) are not disturbed.

**Phase toggle semantics (same as Claude):**
- Off during research (must allow exit without commits)
- On during impl + review (forces the agent to commit before claiming done)

**Arthur tracing:** the existing tracer Python script and config file are agent-agnostic. The Codex adapter installs the same `~/.claude/hooks/claude_code_tracer.py` content (renamed to `~/.codex/hooks/claude_code_tracer.py`) plus the same `arthur_config.json`, then writes Codex-format hook entries pointing at `python3 "$HOME/.codex/hooks/claude_code_tracer.py" <event_name>` for `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`. The Arthur OTLP/HTTP exporter doesn't care which CLI emitted the events.

## Output Parsing — Codex Specifics

**Two artifacts per phase:**

1. **`/tmp/<phase>-stdout.txt`** — NDJSON event stream from `codex exec --json`. One JSON object per line. Relevant types: `thread.started`, `turn.started`, `turn.completed` (carries `usage`), `item.completed` (carries assistant text), `error`.
2. **`/tmp/<phase>-result.json`** — final assistant message, schema-validated when `--output-schema` is supplied. Written by `-o`. For research (no schema) this contains free-form markdown with the `STATUS:` line on top; for impl/review it contains the JSON object matching `AGENT_SCHEMA` / `REVIEW_SCHEMA`.

**Codex `buildPhaseScript`:** the function returns a bash script string (same shape as today's `buildPhaseScript`). Two variants depending on whether `jsonSchema` is supplied:

Research phase (no schema, free-form markdown output):

```bash
#!/bin/bash
rm -f /tmp/research-done /tmp/research-stdout.txt /tmp/research-stderr.txt /tmp/research-result.json
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

cat /tmp/research-requirements.md | codex exec \
  --model "${model}" \
  --full-auto \
  --skip-git-repo-check \
  --json \
  -o /tmp/research-result.json \
  - \
  > /tmp/research-stdout.txt 2> /tmp/research-stderr.txt; echo $? > /tmp/research-exit-code || true

cd /vercel/sandbox
rm -rf .codex/
git checkout -- .codex/ 2>/dev/null || true
touch /tmp/research-done
```

Impl/review phase (schema-validated JSON output):

```bash
#!/bin/bash
rm -f /tmp/impl-done /tmp/impl-stdout.txt /tmp/impl-stderr.txt /tmp/impl-result.json
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

cat > /tmp/impl-schema.json << 'SCHEMA_EOF'
${jsonSchema}
SCHEMA_EOF

cat /tmp/impl-requirements.md | codex exec \
  --model "${model}" \
  --full-auto \
  --skip-git-repo-check \
  --json \
  --output-schema /tmp/impl-schema.json \
  -o /tmp/impl-result.json \
  - \
  > /tmp/impl-stdout.txt 2> /tmp/impl-stderr.txt; echo $? > /tmp/impl-exit-code || true

cd /vercel/sandbox
rm -rf .codex/
git checkout -- .codex/ 2>/dev/null || true
touch /tmp/impl-done
```

The schema heredoc uses `'SCHEMA_EOF'` (quoted) so the body is not subject to shell expansion. Schema content with embedded single quotes is escaped at TS-template level — same approach as today's Claude wrapper for `--json-schema`.

`--full-auto` is the documented happy path for non-interactive automation: upgrades to `workspace-write` and grants approval-less execution. We do **not** use `--yolo` / `--dangerously-bypass-approvals-and-sandbox`. `--skip-git-repo-check` is defensive (the sandbox can be in MERGING state during review-fix). `--ephemeral` is **not** used — session files help debug failed runs from a still-running sandbox before teardown.

**Parsers in `codex.ts`:**

```ts
parseAgentOutput(raw, structured) {
  if (structured) {
    try { const parsed = agentOutputSchema.safeParse(JSON.parse(structured));
          if (parsed.success) return parsed.data; } catch {}
  }
  return scanItemCompletedAsAgentOutput(raw)
    ?? { result: "failed", error: `Codex output unparseable. First 500: ${raw.slice(0, 500)}` };
}

parseReviewOutput(raw, structured) { /* same shape, reviewOutputSchema */ }

parseResearchStatus(raw, structured) {
  // Research has no schema. Prefer structured (the -o file holds the assistant message).
  // Fallback: scan NDJSON for the last item.completed text.
  const text = structured ?? unwrapLastItemCompleted(raw);
  return parseStatusLine(text);
}

extractUsage(raw, _structured) {
  // Walk NDJSON in reverse for type === "turn.completed"; sum usage across turns.
  // Returns { cost_usd: null, tokens: { input, cached_input, output }, duration_ms, num_turns }
}
```

**`collectPhase` helper** (new, in `poll-agent.ts`):

```ts
export async function collectPhase(
  sandboxId: string,
  paths: { stdout: string; stderr: string; structuredOutput: string | null },
): Promise<{ raw: string; structured: string | null }>;
```

Reads stdout (with stderr fallback when stdout is empty, mirroring existing `collectPhaseOutput`), reads `structuredOutput` if non-null. Workflow swaps `collectPhaseOutput` calls for this.

## Pricing

**`PhaseUsage` shape — agent-agnostic:**

```ts
export interface PhaseUsage {
  cost_usd: number | null;             // populated by Claude directly; computed from tokens for Codex
  tokens: { input: number; cached_input: number; output: number } | null;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
}
```

- Claude's `extractUsage` returns `cost_usd` from its envelope (Claude CLI computes the dollars itself).
- Codex's `extractUsage` returns `cost_usd: null` and `tokens` from `turn.completed`.

**`pricing.ts`:**

```ts
export interface TokenPrice { input: number; cached_input: number; output: number }

/** TTL-cached fetch from CODEX_PRICING_URL. Returns null on miss/failure. */
export async function fetchModelPrice(model: string): Promise<TokenPrice | null>;
```

LiteLLM's JSON keys models by canonical name with per-token costs (`input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`). The module normalizes them to `TokenPrice`. Cache TTL is 1h by default (`CODEX_PRICING_TTL_MS`).

**`formatUsageReport(phases, priceLookup)`:** for each phase, if `cost_usd != null` use it; else if tokens + price are available, compute `cost = (tokens.input * price.input + tokens.cached_input * price.cached_input + tokens.output * price.output)`; else show tokens-only with the `cost unknown` marker. Always informative, never fabricated.

**Verification before shipping:** fetch the LiteLLM JSON once, confirm `gpt-5-codex` (and the most likely operator alternatives — `gpt-5`, `gpt-5-mini`) are listed with the expected fields. If a model is missing, the tokens-only fallback handles it gracefully and the operator can override `CODEX_PRICING_URL`.

## Error Handling & Edge Cases

| Failure | Handling |
|---|---|
| Schema validation failure (no `result.json` written) | Parser falls back to NDJSON `item.completed` scan; if that fails, returns `failed` and the workflow moves the ticket to BACKLOG via the existing path |
| Hook script missing or unexecutable | `agent.configure` does `chmod +x` and asserts `test -f`; throws if missing — `provisionSandbox` (`maxRetries=0`) propagates to the workflow's top-level catch |
| Codex CLI install fails | Same as above — surface via `agent.install` throw |
| Pricing fetch fails | Workflow continues; tokens-only Slack output; logged at WARN |
| `turn.completed` missing | `extractUsage` returns null; Slack shows `Phase: n/a` (existing behavior) |
| Sentinel never written | Existing `pollUntilDone` timeout path; ticket → BACKLOG |
| Commit-guard infinite loop | Hook checks `already_blocked` flag and returns `continue: true` on the second invocation; `JOB_TIMEOUT_MS` bounds worst case |
| `AGENT_KIND` changes mid-flight | `provisionSandbox` returns `{ sandboxId, agentKind }`; downstream steps reconstruct adapter from the persisted value, not from the live env |

**Logging:**
- `agent_install_started` / `agent_install_complete` — tagged with `kind`
- `phase_started` / `phase_completed` — tagged with `kind`
- `pricing_fetch_failed` — WARN with URL, model
- `commit_guard_triggered` — INFO when the hook blocks

## Testing

**Unit:**
- `src/sandbox/agents/codex.test.ts` — research status from `result.json`, agent output from `result.json`, fallback to NDJSON `item.completed`, `extractUsage` from `turn.completed` (single + multi-turn), commit-guard JSON shape
- `src/sandbox/agents/claude.test.ts` — relocates the existing parser tests; same coverage as today
- `src/sandbox/agents/index.test.ts` — `createAgentAdapter` selection by `AGENT_KIND`; throws on missing creds
- `src/sandbox/agents/pricing.test.ts` — fetch + cache + fallback, mocked HTTP
- `src/sandbox/manager.test.ts` — refactored to assert delegation to a fake adapter

**E2E:**
- New `e2e/codex-tier-1.test.ts` — provisions a sandbox with `AGENT_KIND=codex`, runs the impl phase against a tiny seeded ticket, asserts a commit and PR. **Skipped by default**; gated on `CODEX_API_KEY` being set in CI
- Existing Tier-1 / Tier-2 e2e (Claude path) untouched — must pass after the refactor

## Rollout

1. **Refactor only** — extract Claude logic into `claude.ts`, introduce `AgentAdapter`, slim `SandboxManager`. Existing tests + Tier-1 e2e must pass. Ship as one commit.
2. **Add Codex adapter** — `codex.ts`, `pricing.ts`, env vars, factory selection. Unit tests pass. No Codex e2e yet.
3. **Codex e2e** — add the gated tier-1 test. Validate manually against a sandbox project, then add a CI job that runs only when `CODEX_API_KEY` is configured.
4. **Documentation** — update README + `.env.example`. Add a short "Switching agents" section.

## Open Verifications (Pre-Implementation)

These are first-30-minutes-of-implementation checks, not spec-blocking risks:

1. LiteLLM JSON URL is reachable and `gpt-5-codex` is listed with the expected fields. Operator override (`CODEX_PRICING_URL`) is the escape hatch if the source moves.
2. The `skills` CLI accepts `--target` against the version Blazebot installs. Fallback: install into `~/.claude/skills/` and symlink `~/.agents/skills → ~/.claude/skills`.
3. Codex's `--output-schema` behavior on validation failure (does it crash the run or surface errors and continue?). Affects how aggressively the parser falls back to the NDJSON scan.

## Net Change Summary

- **New files:** `src/sandbox/agents/{types,claude,codex,shared,index,pricing}.ts` + tests, `e2e/codex-tier-1.test.ts`
- **Deleted:** `src/sandbox/wrapper-script.ts`, possibly `src/sandbox/agent-runner.ts` (if it ends up empty)
- **Modified:** `src/sandbox/manager.ts`, `src/sandbox/poll-agent.ts`, `src/sandbox/usage.ts`, `src/workflows/agent.ts`, `env.ts`, `.env.example`, `README.md`
- **Untouched:** all VCS adapters, issue-tracker adapters, messaging adapters, run registry, reconcile, dispatch, Jira webhook, cron, attachments, Arthur client
- **Estimated size:** ~700–900 LOC net add, ~250–350 LOC moved between files
