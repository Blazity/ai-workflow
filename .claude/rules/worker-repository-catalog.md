---
paths:
  - "apps/worker/src/services/repository-catalog/**"
  - "apps/worker/src/services/dispatch/**"
  - "apps/worker/src/services/manual-dispatch/**"
  - "apps/worker/src/services/triggers/**"
  - "apps/worker/src/db/repositories/repository-catalog.ts"
  - "apps/worker/src/db/repositories/repository-catalog-history.ts"
  - "apps/worker/src/routes/api/v1/repository-catalog.get.ts"
  - "apps/worker/src/routes/api/v1/repository-catalog/**"
  - "apps/worker/src/engine/agent-workflow.ts"
  - "apps/worker/src/engine/steps/run-start-settings.ts"
  - "apps/worker/src/engine/support/repository-access.ts"
  - "apps/worker/src/engine/blocks/pre-pr-checks.ts"
  - "apps/worker/src/engine/steps/workspace-gate.ts"
---

# Worker repository catalog

- Keep catalog state, repository rows, profiles, and check configuration behind `apps/worker/src/db/repositories/repository-catalog.ts`; profile-history pagination is the isolated exception in `apps/worker/src/db/repositories/repository-catalog-history.ts`. Load one immutable snapshot per entry point in `apps/worker/src/services/repository-catalog/store.ts`, then ask the synchronous policy in `apps/worker/src/services/repository-catalog/policy.ts`.
- Treat an unactivated catalog as the explicit bridge: every repository is enabled and `reportBridge` reports that the catalog is not deciding access. Once activated, only enabled keys pass.
- Ask `isRepositoryDispatchable` for all four dispatch paths: automatic pull or merge request events, the legacy post-PR gate fallback, dashboard manual pull request dispatch, and MCP dispatch. The shared predicate lives in `apps/worker/src/services/dispatch/repo-allowlist.ts`; trigger and manual-dispatch services must receive the entry point's snapshot.
- Treat a workflow repository pin only as a selection inside the catalog; it grants neither dispatch nor in-run access. Inside a run, use the enabled keys frozen on `ctx.repositories` (disabling a repository stops the next run, not one in flight) and the helpers in `apps/worker/src/engine/support/repository-access.ts` for discovery, expansion, publication, promotion, pull requests, comments, and fetch context.
- Do not gate ticket dispatch on the catalog. After loading the deployed graph, a ticket run with an activated empty catalog refuses only when `runStartHasNoEnabledRepository` and `workflowNeedsRepositoryAccess` are both true; `apps/worker/src/engine/agent-workflow.ts` sends `NO_ENABLED_REPOSITORY_MESSAGE` through the transparent-failure exit, where that sentence becomes the run status reason and ticket comment. There is no separate failure-kind field.
- Do not read `AGENT_ALLOWED_REPOS`; catalog snapshots and frozen `ctx.repositories` own repository access. Guard: `apps/worker/src/services/settings/consumers-guard.test.ts` forbids that environment read inside a run.
- Keep profile authoring separate from access grants. A new row written by a profile save is disabled unless an enabled route grants it, and changing an existing profile never changes its enabled state; the policy is in `apps/worker/src/services/repository-catalog/authoring.ts` and the repository write defaults in `apps/worker/src/db/repositories/repository-catalog.ts`.
- Preserve both repository counters: `current_profile_version` moves with each saved profile version, while `current_checks_version` moves only when script groups or gate selection change. Carry the checks version from `loadPrePrCheckConfigStep` into optional `repositoryVersions`; recovery must accept gates with or without it.
- Do not add or convert another operation into a step call on the workspace gate path. An extra step changes the journal positions of runs already in flight; carry the launch-time checks version out of `loadPrePrCheckConfigStep` in `apps/worker/src/engine/blocks/pre-pr-checks.ts`.

History: docs/archive/agent-notes/worker-settings-and-catalog.md
