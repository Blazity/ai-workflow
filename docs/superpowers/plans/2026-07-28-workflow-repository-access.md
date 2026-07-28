# Workflow Repository Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every provider-visible repository in the dashboard while allowing only globally permitted repositories or exact repositories pinned in the deployed workflow to execute.

**Architecture:** Separate provider catalog visibility from runtime authorization. Provider adapters return raw accessible repositories; a shared policy composes `AGENT_ALLOWED_REPOS` with the immutable workflow scope at every selection and mutation boundary. The catalog API also returns provider connection states, which drive modal defaults, filtering, and disabled controls.

**Tech Stack:** TypeScript, H3 worker routes, React/Next.js dashboard, Vitest worker tests, Node test runner dashboard tests.

## Global Constraints

- An exact repository pin may extend `AGENT_ALLOWED_REPOS`; provider selection alone may not.
- Authorization uses the deployed workflow snapshot captured by the run, never an unsaved draft.
- An absent repository pin preserves global-allowlist-only behavior.
- An absent provider scope means all configured providers.
- Provider and repository path form the authorization key; paths compare case-insensitively.
- Existing final guards before reads and provider mutations remain present.
- All configured providers are active by default in the modal.
- An unconfigured provider is disabled and labeled `Not connected`.
- Deactivating a provider filters its catalog rows and removes its pins from the modal draft.
- The last configured provider cannot be deactivated.
- No database migration and no new dependency.

---

### Task 1: Define the composed repository authorization policy

**Files:**
- Modify: `apps/worker/src/lib/repo-allowlist.ts`
- Modify: `apps/worker/src/lib/repo-allowlist.test.ts`

**Interfaces:**
- Consumes: `WorkflowRepositoryScope`, `{ provider, repoPath }`
- Produces:
  - `isRepoAllowedForScope(repository, scope): boolean`
  - `filterRepositoriesForScope(repositories, scope): T[]`

- [ ] **Step 1: Write failing policy tests**

Add tests proving:

```ts
const globallyAllowed = { provider: "github" as const, repoPath: "acme/api" };
const pinnedOutsideGlobal = {
  provider: "gitlab" as const,
  repoPath: "group/tool",
};

expect(isRepoAllowedForScope(globallyAllowed, undefined)).toBe(true);
expect(
  isRepoAllowedForScope(pinnedOutsideGlobal, {
    repositories: [{ provider: "gitlab", repoPath: "GROUP/TOOL" }],
  }),
).toBe(true);
expect(
  isRepoAllowedForScope(pinnedOutsideGlobal, { providers: ["gitlab"] }),
).toBe(false);
expect(
  isRepoAllowedForScope(
    { provider: "github", repoPath: "group/tool" },
    { repositories: [{ provider: "gitlab", repoPath: "group/tool" }] },
  ),
).toBe(false);
```

Also prove `filterRepositoriesForScope` returns the union of globally allowed
repositories and exact pins without widening for provider-only scope.

- [ ] **Step 2: Run the policy test and verify RED**

Run:

```bash
pnpm --filter worker test -- src/lib/repo-allowlist.test.ts
```

Expected: FAIL because the composed policy exports do not exist.

- [ ] **Step 3: Implement the minimal policy**

Use an exact provider plus lower-cased path key:

```ts
function repositoryKey(repository: {
  provider: VcsProviderKind;
  repoPath: string;
}): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

export function isRepoAllowedForScope(
  repository: { provider: VcsProviderKind; repoPath: string },
  scope: WorkflowRepositoryScope | undefined,
): boolean {
  if (isRepoAllowed(repository.repoPath)) return true;
  const pinned = new Set(
    (scope?.repositories ?? []).map(repositoryKey),
  );
  return pinned.has(repositoryKey(repository));
}
```

Implement the filter as a stable `Array.prototype.filter` over this predicate.
Do not change `isRepoAllowed`; legacy callers without a workflow scope remain
globally restricted.

- [ ] **Step 4: Run the policy test and verify GREEN**

Run the Task 1 test command and confirm every policy case passes.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/repo-allowlist.ts apps/worker/src/lib/repo-allowlist.test.ts
git commit -m "feat(worker): compose repository pins with global access"
```

---

### Task 2: Return the raw catalog and provider states

**Files:**
- Modify: `apps/shared/contracts/api.ts`
- Modify: `apps/worker/src/adapters/vcs/repository-directory.ts`
- Modify: `apps/worker/src/adapters/vcs/repository-directory.test.ts`
- Modify: `apps/worker/src/routes/api/v1/repositories.get.ts`
- Modify: `apps/worker/src/routes/api/v1/repositories.test.ts`
- Modify: `apps/dashboard/app/api/repositories/route.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RepositoryProviderStatus {
  provider: VcsProviderKind;
  status: "ready" | "not_connected" | "error";
  error?: string;
}

export interface RepositoriesResponse {
  repositories: RepositoryOption[];
  providers: RepositoryProviderStatus[];
}
```

- [ ] **Step 1: Write failing adapter and route tests**

Change the adapter test that currently expects `AGENT_ALLOWED_REPOS` filtering
to expect every provider-visible repository. Add route tests with:

```ts
expect(response.repositories).toEqual([
  expect.objectContaining({ repoPath: "Blazity/allowed" }),
  expect.objectContaining({ repoPath: "Blazity/outside-env-allowlist" }),
]);
expect(response.providers).toEqual([
  { provider: "github", status: "ready" },
  { provider: "gitlab", status: "not_connected" },
]);
```

Add a partial-failure case where GitHub returns repositories and GitLab returns
an error state without discarding the GitHub catalog.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter worker test -- src/adapters/vcs/repository-directory.test.ts src/routes/api/v1/repositories.test.ts
pnpm --dir apps/dashboard exec tsx --test app/api/repositories/route.test.ts
```

Expected: existing adapter filters the second repository and the response lacks
provider states.

- [ ] **Step 3: Remove allowlist filtering from provider adapters**

Return mapped GitHub and GitLab listings directly from their directories.
Delete only the now-unused `filterAllowedRepositories` import. Runtime filtering
is added in Task 3 before any repository can be selected.

- [ ] **Step 4: Extend the catalog route**

Use `listRepositoriesAcrossProviders(getConfiguredVcsProviders())`. Return
successful repositories plus one state for each supported provider:

- configured and fulfilled → `ready`
- configured and rejected → `error` with the sanitized listing message
- missing credentials → `not_connected`

Cache the complete `RepositoriesResponse`, not only its repository array.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run both Task 2 commands and confirm raw visibility, provider states, partial
failure, and dashboard proxy behavior pass.

- [ ] **Step 6: Commit**

```bash
git add apps/shared/contracts/api.ts apps/worker/src/adapters/vcs/repository-directory.ts apps/worker/src/adapters/vcs/repository-directory.test.ts apps/worker/src/routes/api/v1/repositories.get.ts apps/worker/src/routes/api/v1/repositories.test.ts apps/dashboard/app/api/repositories/route.test.ts
git commit -m "feat(worker): expose complete repository catalog"
```

---

### Task 3: Restrict runtime selection to global access plus exact pins

**Files:**
- Modify: `apps/worker/src/pre-sandbox/steps/repo-selection.ts`
- Modify: `apps/worker/src/pre-sandbox/steps/repo-selection.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`
- Modify: `apps/worker/src/workflows/blocks/prepare-workspace.ts`
- Modify: `apps/worker/src/workflows/multi-repo-research.test.ts`
- Modify: `apps/worker/src/workflows/blocks/io-blocks.edge.test.ts`

**Interfaces:**
- Consumes: `filterRepositoriesForScope(repositories, repositoryScope)`
- Preserves: provider narrowing through `filterPinnedRepositories`

- [ ] **Step 1: Write failing selection tests**

Cover these independent cases:

1. raw catalog contains a globally allowed repo, an exact pin outside the
   allowlist, and an unrelated repo outside the allowlist;
2. automatic selection sees the first two but never the unrelated repo;
3. provider-only scope sees only globally allowed repositories;
4. approved-plan and human/model expansion reject an outside repo unless it is
   an exact definition pin.

- [ ] **Step 2: Run selection tests and verify RED**

```bash
pnpm --filter worker test -- src/pre-sandbox/steps/repo-selection.test.ts src/workflows/multi-repo-research.test.ts src/workflows/blocks/io-blocks.edge.test.ts
```

Expected: raw adapter output allows unrelated repositories into selection or
the existing `isRepoAllowed` checks reject an exact pin.

- [ ] **Step 3: Filter every runtime catalog with the composed policy**

In `repoSelectionStep`, apply:

```ts
const repositories = filterRepositoriesForScope(
  listing.repositories,
  repositoryScope,
);
```

before selection and narrowing telemetry.

Apply the same composed filter to fresh model-expansion catalogs and
approved-scope resolution. Pass `ctx.repositoryScope` into human expansion and
workspace hydration. Provider-only scope continues to narrow providers but
does not add a repository exception.

- [ ] **Step 4: Run selection tests and verify GREEN**

Run the Task 3 test command and confirm only global members and exact pins can
enter a workspace.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/pre-sandbox/steps/repo-selection.ts apps/worker/src/pre-sandbox/steps/repo-selection.test.ts apps/worker/src/workflows/agent.ts apps/worker/src/workflows/blocks/prepare-workspace.ts apps/worker/src/workflows/multi-repo-research.test.ts apps/worker/src/workflows/blocks/io-blocks.edge.test.ts
git commit -m "feat(worker): authorize pinned repositories during selection"
```

---

### Task 4: Enforce the composed policy at trigger and mutation boundaries

**Files:**
- Modify: `apps/worker/src/lib/dispatch-trigger.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.test.ts`
- Modify: `apps/worker/src/manual-dispatch/resolve.ts`
- Modify: `apps/worker/src/manual-dispatch/resolve.test.ts`
- Modify: `apps/worker/src/routes/webhooks/github.post.ts`
- Modify: `apps/worker/src/routes/webhooks/github.post.test.ts`
- Modify: `apps/worker/src/routes/webhooks/gitlab.post.ts`
- Modify: `apps/worker/src/routes/webhooks/gitlab.post.test.ts`
- Modify: `apps/worker/src/workflows/blocks/fetch-pr-context.ts`
- Modify: `apps/worker/src/workflows/blocks/post-pr-comment.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.test.ts`
- Modify: `apps/worker/src/workflows/repository-promotion.ts`
- Modify: `apps/worker/src/workflows/repository-promotion.test.ts`
- Modify: `apps/worker/src/workflows/repository-prs.ts`
- Modify: `apps/worker/src/workflows/repository-prs.test.ts`
- Modify: `apps/worker/src/workflows/workspace-publication.ts`
- Modify: `apps/worker/src/workflows/workspace-publication.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`

**Interfaces:**
- Every scoped boundary accepts `repositoryScope?: WorkflowRepositoryScope`.
- Every authorization call receives `{ provider, repoPath }`, not path alone.

- [ ] **Step 1: Write failing trigger tests**

For automatic and manual dispatch, prove:

- globally disallowed + exact deployed pin → accepted;
- globally disallowed + provider-only scope → ignored/rejected;
- same path pinned for the other provider → ignored/rejected;
- workflow-owned remediation preserves its existing ownership behavior.

For webhook routes, remove only the premature global rejection that prevents
the dispatcher from consulting the deployed definition. Keep legacy post-PR
gate behavior globally restricted.

- [ ] **Step 2: Run trigger tests and verify RED**

```bash
pnpm --filter worker test -- src/lib/dispatch-trigger.test.ts src/manual-dispatch/resolve.test.ts src/routes/webhooks/github.post.test.ts src/routes/webhooks/gitlab.post.test.ts
```

Expected: exact pins outside the environment allowlist are rejected before
their deployed definition is evaluated.

- [ ] **Step 3: Implement scoped trigger admission**

Move composed authorization after the deployed definition has been loaded:

```ts
if (
  scope === "any" &&
  !isRepoAllowedForScope(event.pr, enabled.current.definition.repositoryScope)
) {
  return { result: "ignored_provider" };
}
```

Mirror this in manual dispatch. Let normalized workflow events reach the
dispatcher; keep standalone legacy gates on `isRepoAllowed`.

- [ ] **Step 4: Write failing final-boundary tests**

For each read/write boundary, add one exact-pin acceptance and one
provider-only rejection:

- PR context read;
- research attach;
- trusted workspace publisher;
- repository promotion;
- PR/MR creation;
- PR/MR comment.

The tests pass a frozen `repositoryScope` through the public boundary rather
than mocking `isRepoAllowed`.

- [ ] **Step 5: Run boundary tests and verify RED**

```bash
pnpm --filter worker test -- src/sandbox/trusted-workspace-publisher.test.ts src/workflows/repository-promotion.test.ts src/workflows/repository-prs.test.ts src/workflows/workspace-publication.test.ts src/workflows/blocks/io-blocks.edge.test.ts
```

Expected: exact pins still fail the old global-only checks.

- [ ] **Step 6: Thread the immutable scope through final guards**

Add `repositoryScope?: WorkflowRepositoryScope` to the relevant step inputs and
pass `ctx.repositoryScope` from the engine into:

- `blockFetchPrContextsStep`;
- `attachResearchRepositoriesStep`;
- `blockPostPrCommentStep`;
- `finalizeWorkspacePublication`;
- `publishTrustedWorkspaceFromSandbox`;
- repository promotion controller;
- `createOrFindWorkflowOwnedPullRequest`.

Replace each scoped `isRepoAllowed(repo.repoPath)` call with
`isRepoAllowedForScope(repo, repositoryScope)`. Leave callers that have no run
scope on `isRepoAllowed`, preserving fail-closed behavior.

- [ ] **Step 7: Run boundary and trigger tests and verify GREEN**

Run the Task 4 commands. Confirm all acceptance tests use an exact deployed pin
and every provider-only/cross-provider case remains rejected.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src
git commit -m "feat(worker): enforce workflow repository exceptions"
```

---

### Task 5: Drive provider UX from server connection states

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/flow-editor-validation.test.tsx`

**Interfaces:**
- `RepositoryCatalogState.providers: RepositoryProviderStatus[]`
- Effective providers are all `ready` or `error` providers when
  `scope.providers` is absent.

- [ ] **Step 1: Write failing static and behavior tests**

Prove:

- GitHub and GitLab are active by default when both report `ready`;
- a `not_connected` provider is disabled and displays `Not connected`;
- a configured provider with zero repositories remains active;
- deactivating GitHub hides GitHub rows and removes GitHub pins from the draft;
- Cancel restores the saved scope and pins;
- Apply persists `providers: ["gitlab"]`;
- the final active provider cannot be deactivated;
- reactivating all configured providers normalizes the provider array away.

- [ ] **Step 2: Run dashboard tests and verify RED**

```bash
pnpm --dir apps/dashboard exec tsx --test components/cockpit/flow-editor/repository-catalog-context.test.tsx components/cockpit/flow-editor/repository-scope-bar.test.tsx components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx components/cockpit/flow-editor/flow-editor-validation.test.tsx
```

Expected: context has no provider states, empty scope renders no buttons active,
and catalog rows do not follow provider toggles.

- [ ] **Step 3: Store provider states in catalog context**

Validate both `repositories` and `providers` in the API response. A malformed
array moves the whole catalog to `error`; valid provider `error` entries remain
data and do not turn the entire context into transport error.

- [ ] **Step 4: Implement provider defaults and filtering**

Derive:

```ts
const configuredProviders = catalog.providers
  .filter(({ status }) => status !== "not_connected")
  .map(({ provider }) => provider);

const activeProviders =
  (draft.providers?.length ?? 0) > 0
    ? draft.providers!
    : configuredProviders;
```

When toggling off a provider:

1. refuse if it is the last active provider;
2. materialize the remaining provider array;
3. remove pinned repositories owned by the disabled provider.

When toggling on restores every configured provider, omit `providers` during
normalization. Filter catalog rows by `activeProviders` before the text query.

- [ ] **Step 5: Run dashboard tests and verify GREEN**

Run the Task 5 command and confirm modal draft, cancel/apply, filtering, and
connectivity states behave as specified.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/cockpit/flow-editor apps/shared/contracts
git commit -m "feat(dashboard): align provider scope with repository catalog"
```

---

### Task 6: Full verification and production handoff

**Files:**
- Verify only; modify tests or implementation only if a failure demonstrates a
  requirement gap.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check
git status --short
```

- [ ] **Step 2: Run all worker tests**

```bash
pnpm --filter worker test
```

Expected: zero failed tests.

- [ ] **Step 3: Run all dashboard tests**

```bash
pnpm --filter ai-workflow-dashboard test
```

Expected: zero failed tests.

- [ ] **Step 4: Run typechecks**

```bash
pnpm --filter worker typecheck
pnpm --filter ai-workflow-dashboard typecheck
```

- [ ] **Step 5: Run production builds**

```bash
pnpm --filter worker build
pnpm --filter ai-workflow-dashboard build
```

- [ ] **Step 6: Verify the complete behavior locally**

With worker on `3100` and dashboard on `3101`, verify:

1. both configured providers are active;
2. GitHub and GitLab repositories appear;
3. deselecting GitHub leaves only GitLab rows;
4. selecting a repo outside `AGENT_ALLOWED_REPOS`, applying, saving, and
   deploying the workflow allows that exact repo;
5. an unpinned outside repo remains unavailable to automatic selection.

- [ ] **Step 7: Commit any verification-only corrections**

Use a narrowly scoped commit message matching the demonstrated failure. Do not
commit local `.env` files.

