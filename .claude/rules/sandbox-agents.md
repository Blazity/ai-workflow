---
paths:
  - "apps/worker/src/sandbox/**"
  - "apps/worker/src/harness-profiles/**"
---

# Sandboxed coding agents

- `@vercel/sandbox` git clones can be shallow by default, which produces "no
  history in common with main" when the sandbox force-pushes and a PR is
  created. Always unshallow before pushing (`git fetch --unshallow origin`).
- `GitHubAdapter.createBranch` must force-reset an existing branch to the base
  SHA on 422, not silently return: a stale branch from a previous failed run
  keeps orphan history.
- The Claude Code CLI rejects OAuth tokens (`sk-ant-oat...`) supplied through
  `ANTHROPIC_API_KEY`; that variable accepts standard API keys
  (`sk-ant-api...`) only. `src/sandbox/agents/claude.ts` detects the
  `sk-ant-oat` prefix and exports the value as `CLAUDE_CODE_OAUTH_TOKEN` inside
  the sandbox, so the operator still pastes one variable.
- Codex creates `.codex/` in the working directory at runtime. Without
  intervention the agent reads it as untracked pollution, "fixes" it by adding
  `.codex/` to `.gitignore`, and commits only that.
  `CodexAgentAdapter.configure` writes `.codex/` to `.git/info/exclude` for
  exactly this reason.
- Prompts must forbid the `using-git-worktrees` and `executing-plans` skills,
  any `git worktree` command and any `.gitignore` change. That skill chain is
  the dominant cause of empty PRs and gitignore-only commits, and the block has
  to be in the prompt body to override the skill text.
- `extractUsage` cannot derive a duration from Codex NDJSON events, which carry
  no timestamp key. The wrapper appends a synthetic
  `{"type":"phase.duration","duration_ms":N}` line so reports show real
  wall-clock minutes instead of `0m`.
- Anything that retries a push must dispatch the configured agent's CLI, not a
  hardcoded `claude`. With `AGENT_KIND=codex` the claude binary is absent and a
  trailing `|| true` swallows the failure, leaving the same broken HEAD to be
  force-pushed.
