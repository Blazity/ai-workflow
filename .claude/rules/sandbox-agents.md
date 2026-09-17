---
paths:
  - "apps/worker/src/sandbox/agents/**"
  - "apps/worker/src/sandbox/arthur-*.ts"
  - "apps/worker/src/harness-profiles/**"
  - "packages/prompts/**"
---

# Sandboxed coding agents

- Route Claude credentials by prefix.
  `apps/worker/src/sandbox/agents/claude.ts` exports values beginning with
  `sk-ant-oat` as `CLAUDE_CODE_OAUTH_TOKEN` and all other values as
  `ANTHROPIC_API_KEY` inside the sandbox.
- Keep Codex runtime state out of repository changes.
  `CodexAgentAdapter.configure` writes `.codex/` to `.git/info/exclude`, and the
  phase script removes `.codex/` during cleanup; do not add it to `.gitignore`.
- Keep the git hygiene restrictions in `packages/prompts/default-prompts.ts`:
  no `git worktree` command, and no `.gitignore` change unless the ticket or
  implementation plan explicitly requires it. The prompts do not name skills.
- `extractUsage` cannot derive a duration from Codex NDJSON events, which carry
  no timestamp key. The wrapper appends a synthetic
  `{"type":"phase.duration","duration_ms":N}` line so reports show real
  wall-clock minutes instead of `0m`.

History: docs/archive/agent-notes/packages-and-adapters.md
