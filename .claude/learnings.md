
## chat package API (v4.20.2)
- `ChatConfig` requires both `state: StateAdapter` and `userName: string` as mandatory fields. There is no built-in no-op state adapter exported; you must implement the `StateAdapter` interface yourself for outbound-only use cases.
- `createSlackAdapter` accepts `SlackAdapterConfig` — the bot token field is `botToken`, not `token`.
- `StartOptions` in `workflow/api` has no `id` property; valid options are `deploymentId`, `world`, and `specVersion`.
