
## chat package API (v4.20.2)
- `ChatConfig` requires both `state: StateAdapter` and `userName: string` as mandatory fields. There is no built-in no-op state adapter exported; you must implement the `StateAdapter` interface yourself for outbound-only use cases.
- `createSlackAdapter` accepts `SlackAdapterConfig` — the bot token field is `botToken`, not `token`.
- `StartOptions` in `workflow/api` has no `id` property; valid options are `deploymentId`, `world`, and `specVersion`.

## Sandbox push & branch creation
- `@vercel/sandbox` git clones can be shallow by default, causing "no history in common with main" on PR creation when force-pushing from the sandbox. Always unshallow before pushing (`git fetch --unshallow origin`).
- `GitHubAdapter.createBranch` must force-reset existing branches to the base SHA on 422, not silently return. Stale branches from previous failed runs can retain orphan history.

## Jira adapter
- Jira REST v3 comments require ADF, and **ADF text nodes cannot contain `\n`**. Multi-line content must be modeled as multiple paragraph nodes (or use `hardBreak` inline nodes between text nodes). Stuffing newline-joined text into a single text node returns 400 Bad Request on `/rest/api/3/issue/{id}/comment`. Adapter helper `toAdfParagraphs` splits on `\n` and emits one paragraph per line.

## Codex agent in Vercel Sandbox
- The `using-git-worktrees` superpowers skill is the dominant root cause of empty-PR / `.gitignore`-only commits, NOT `.codex/` pollution. The skill's contract: "If the worktree directory is not in .gitignore, add it and commit before proceeding." The `executing-plans` skill REQUIRES `using-git-worktrees`, so any prompt that tells the agent to use `executing-plans` chains into "modify .gitignore + commit" before any real implementation work. Confirmed on AWT-641 / AWT-642. Mitigation: prompts (research + implement) explicitly forbid invoking `using-git-worktrees`/`executing-plans` and forbid any `git worktree` command or `.gitignore` change. The block is in the prompt body and must override conflicting skill text.
- Codex CLI also creates `.codex/` in cwd at runtime (per-session state). Without intervention, the agent sees it as untracked pollution in `git status`, "fixes" it by adding `.codex/` to `.gitignore`, commits only that. Mitigation: `CodexAgentAdapter.configure` writes `.codex/` to `.git/info/exclude` so it's hidden from the agent's git status. The post-phase cleanup `rm -rf .codex/` exists for the same reason but only runs after the agent exits.
- `extractUsage` cannot derive duration from Codex NDJSON event timestamps (the events do not carry `timestamp`/`ts`/`time` keys). The wrapper script appends a synthetic `{"type":"phase.duration","duration_ms":N}` line to stdout as a fallback so Slack reports show real wall-clock minutes instead of `0m`.
- Codex Stop-hook protocol accepts BOTH `{"decision":"block","reason":"..."}` (legacy) and `{"continue":true,"stopReason":"..."}` (new) on stdout with exit 0 to force the agent to take another turn — confirmed against developers.openai.com/codex/hooks. Either format works; the codebase uses the legacy one for parity with the Claude commit-guard.
- `fixAndRetryPush` must dispatch the configured agent's CLI, not hardcode `claude`. When AGENT_KIND=codex the claude binary isn't installed and `|| true` swallows the failure, leaving the same broken HEAD to be force-pushed.

## E2E in GitHub Actions
- `@vercel/sandbox` reads credentials from `process.env` — a GH secret is not enough; it must be mapped via the job's `env:` block (e.g. `VERCEL_OIDC_TOKEN: ${{ secrets.VERCEL_OIDC_TOKEN }}`). Prefer long-lived `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` over OIDC — OIDC tokens expire in ~12h and the SDK's refresh path requires `.vercel/project.json`, which CI doesn't have.
- Reconcile (`src/lib/reconcile.ts`) has a 30s `ORPHAN_GRACE_MS` window that skips entries younger than 30s. Any e2e test seeding a registry entry via `setEntry` and expecting reconcile to cancel it on the next cron tick must backdate the timestamp past the grace window (`setEntry(key, runId, { ageMs: 60_000 })`). Without backdating the test is racy — it only passes if Vercel's 1-min scheduled cron happens to fire at T>30s during the test's wait window.
