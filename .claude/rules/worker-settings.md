---
paths:
  - "apps/worker/src/routes/**"
  - "apps/worker/src/services/**"
  - "apps/worker/src/mcp/**"
  - "apps/worker/src/infra/**"
  - "apps/worker/src/engine/**"
  - "apps/worker/src/pre-sandbox/**"
  - "apps/worker/src/workflow-graph-suites/**"
  - "packages/contracts/settings-registry.ts"
  - "packages/contracts/settings-resolution.ts"
  - "integrations/sdk/settings.ts"
  - "integrations/registry/index.ts"
---

# Worker settings

- Core's settings are defined in `packages/contracts/settings-registry.ts`; an integration declares its own in its manifest (`settings`), translated once in `integrations/sdk/settings.ts`. Every settings surface reads the one joined list, `settingDefinitions` and `settingDefinition` in `integrations/registry/index.ts`. Values live in the settings store; owner or admin changes through `apps/worker/src/routes/api/v1/settings.patch.ts` or MCP `settings.set` record the actor and reason in settings history.
- Load one immutable settings snapshot where work enters and pass it down synchronously. HTTP handlers share `getRequestSettingsSnapshot(event)` from `apps/worker/src/services/settings/request-snapshot.ts`; the poll cron loads once in `apps/worker/src/routes/cron/poll.get.ts`. Accessors must not quietly become asynchronous because a promise used as a boolean enables a feature.
- Freeze settings and repository access at run start with `loadRunStartSettingsStep`, then read only `ctx.settings`, `ctx.repositories`, or explicit parameters. Nothing inside a run may re-read either store, use a module cache, or fall back to environment because a run can outlive its read and replay through a different branch. `apps/worker/src/engine/steps/run-start-settings.ts` is the only engine file allowed to read the settings or repository-catalog repositories, and nothing reachable from the workflow isolate may import their services or the database client. Guards: `apps/worker/src/engine/workflow-import-boundary.test.ts`, `apps/worker/src/services/settings/consumers-guard.test.ts`. Drain production runs before changing `apps/worker/src/engine/steps/run-start-settings.ts`.
- Require every ordinary settings accessor to accept a snapshot; do not restore a zero-argument or environment fallback. Guard: `apps/worker/src/services/settings/consumers-guard.test.ts` scans routes, services, MCP, infrastructure, engine, pre-sandbox, and workflow-graph suites for retired environment reads and fallback forms.
- Resolve an ordinary setting from a stored row, then the variable it names (only an integration's setting names one; core's ordinary variables are retired), then its default. Integration settings reach only a webhook's `ctx.settings`, from the request snapshot, never a run. A `requiresRedeploy` setting ignores stored residue and resolves from its declared environment variable, then its default; startup rejects names in `RETIRED_ENVIRONMENT_VARIABLES`. The shared resolver lives in `packages/contracts/settings-resolution.ts`, and the runtime check lives in `apps/worker/src/services/settings/retired-environment.ts`.

History: docs/archive/agent-notes/worker-settings-and-catalog.md
