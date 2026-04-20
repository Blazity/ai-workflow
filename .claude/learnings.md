
## chat package API (v4.20.2)
- `ChatConfig` requires both `state: StateAdapter` and `userName: string` as mandatory fields. There is no built-in no-op state adapter exported; you must implement the `StateAdapter` interface yourself for outbound-only use cases.
- `createSlackAdapter` accepts `SlackAdapterConfig` — the bot token field is `botToken`, not `token`.
- `StartOptions` in `workflow/api` has no `id` property; valid options are `deploymentId`, `world`, and `specVersion`.

## Sandbox push & branch creation
- `@vercel/sandbox` git clones can be shallow by default, causing "no history in common with main" on PR creation when force-pushing from the sandbox. Always unshallow before pushing (`git fetch --unshallow origin`).
- `GitHubAdapter.createBranch` must force-reset existing branches to the base SHA on 422, not silently return. Stale branches from previous failed runs can retain orphan history.

## E2E in GitHub Actions
- `@vercel/sandbox` reads credentials from `process.env` — a GH secret is not enough; it must be mapped via the job's `env:` block (e.g. `VERCEL_OIDC_TOKEN: ${{ secrets.VERCEL_OIDC_TOKEN }}`). Prefer long-lived `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` over OIDC — OIDC tokens expire in ~12h and the SDK's refresh path requires `.vercel/project.json`, which CI doesn't have.
- Reconcile (`src/lib/reconcile.ts`) has a 30s `ORPHAN_GRACE_MS` window that skips entries younger than 30s. Any e2e test seeding a registry entry via `setEntry` and expecting reconcile to cancel it on the next cron tick must backdate the timestamp past the grace window (`setEntry(key, runId, { ageMs: 60_000 })`). Without backdating the test is racy — it only passes if Vercel's 1-min scheduled cron happens to fire at T>30s during the test's wait window.
