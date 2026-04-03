
## chat package API (v4.20.2)
- `ChatConfig` requires both `state: StateAdapter` and `userName: string` as mandatory fields. There is no built-in no-op state adapter exported; you must implement the `StateAdapter` interface yourself for outbound-only use cases.
- `createSlackAdapter` accepts `SlackAdapterConfig` — the bot token field is `botToken`, not `token`.
- `StartOptions` in `workflow/api` has no `id` property; valid options are `deploymentId`, `world`, and `specVersion`.

## Sandbox push & branch creation
- `@vercel/sandbox` git clones can be shallow by default, causing "no history in common with main" on PR creation when force-pushing from the sandbox. Always unshallow before pushing (`git fetch --unshallow origin`).
- `GitHubAdapter.createBranch` must force-reset existing branches to the base SHA on 422, not silently return. Stale branches from previous failed runs can retain orphan history.
