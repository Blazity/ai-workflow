# AIW-147 Multi-Repository Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give planning agents bounded, allowlisted multi-repository code access, support iterative repository expansion, and publish changes only from explicitly promoted write repositories.

**Architecture:** Repository metadata is normalized and selected before checkout, with harness-based discovery only when deterministic evidence is insufficient. Research uses a trusted versioned read/write workspace manifest; planning may attach bounded extra read repositories, after which a server-side promotion step creates owned branches only for the declared write set. Existing trusted finalization and approval flows are extended rather than replaced.

**Tech Stack:** TypeScript, Vitest, Zod, Vercel Sandbox, Workflow DevKit, Drizzle/PostgreSQL, GitHub and GitLab adapters.

## Global Constraints

- At most 200 accessible catalog entries.
- Initial discovery selects at most 3 repositories.
- At most 2 expansion rounds, 3 new repositories per round, and 8 total repositories.
- Every repository identity must be revalidated against the server-owned catalog and `AGENT_ALLOWED_REPOS`.
- Research creates no remote branches and may not leave local changes.
- Only repositories explicitly promoted to `write` may be changed or published.
- A foreign same-name branch is never reset or deleted.
- Provider credentials remain server-side and are never persisted in remotes.
- V1 workflows and manifest V1 snapshots remain readable during rollout.
- Mixed GitHub/GitLab workspaces and nested GitLab namespaces remain supported.

---

### Task 1: Repository catalog and discovery contract

**Files:**
- Create: `apps/worker/src/repository-discovery/catalog.ts`
- Create: `apps/worker/src/repository-discovery/catalog.test.ts`
- Create: `apps/worker/src/repository-discovery/protocol.ts`
- Create: `apps/worker/src/repository-discovery/protocol.test.ts`
- Modify: `apps/worker/src/pre-sandbox/steps/repo-selection.ts`
- Modify: `apps/worker/src/pre-sandbox/steps/repo-selection.test.ts`
- Modify: `apps/worker/src/lib/repo-allowlist.ts`
- Modify: `apps/worker/src/lib/repo-allowlist.test.ts`

**Interfaces:**
- Produces: `buildRepositoryCatalog(repositories): RepositoryCatalogEntry[]`.
- Produces: `validateRepositoryDiscoveryResult(raw, catalog, mandatory): DiscoveryDecision`.
- Produces: `RepositorySelectionResult` with `selected`, `discovery_needed`, or `clarification_needed`.
- Consumes: existing `RepositoryMetadata`, workflow-owned branches, and ticket text.

- [ ] **Step 1: Write failing catalog and allowlist tests**

```ts
it("sorts, bounds, and excludes archived repositories", () => {
  expect(buildRepositoryCatalog([archived, repoB, repoA])).toEqual([
    expect.objectContaining({ provider: "github", repoPath: "acme/a" }),
    expect.objectContaining({ provider: "gitlab", repoPath: "group/team/b" }),
  ]);
});

it("accepts nested GitLab namespaces without widening GitHub paths", () => {
  process.env.AGENT_ALLOWED_REPOS = "group/team/repo,acme/app";
  expect(isRepoAllowed("group/team/repo")).toBe(true);
  expect(isRepoAllowed("acme/app")).toBe(true);
  expect(isRepoAllowed("acme/other")).toBe(false);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
pnpm --filter worker exec vitest run src/repository-discovery/catalog.test.ts src/lib/repo-allowlist.test.ts
```

Expected: FAIL because the catalog module and nested-path parsing do not exist.

- [ ] **Step 3: Implement normalized bounded catalog**

```ts
export const MAX_ACCESSIBLE_REPOSITORIES = 200;

export function buildRepositoryCatalog(
  repositories: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  const usable = repositories
    .filter((repo) => !repo.archived)
    .sort((a, b) =>
      `${a.provider}:${a.repoPath.toLowerCase()}`.localeCompare(
        `${b.provider}:${b.repoPath.toLowerCase()}`,
      ),
    );
  if (usable.length > MAX_ACCESSIBLE_REPOSITORIES) {
    throw new RepositoryCatalogError("catalog_limit_exceeded");
  }
  return usable.map(toBoundedCatalogEntry);
}
```

Validate GitLab paths as two or more safe non-empty segments while keeping provider-specific validation in the catalog.

- [ ] **Step 4: Write failing strict discovery protocol tests**

Cover high/medium confidence, low confidence, duplicates, unknown repositories, provider collisions, mandatory repositories, and over-three selection.

```ts
expect(validateRepositoryDiscoveryResult({
  status: "selected",
  confidence: "high",
  repositories: [{ provider: "github", repoPath: "acme/app", rationale: "UI" }],
}, catalog, mandatory)).toEqual({
  kind: "selected",
  repositories: [expect.objectContaining({ repoPath: "acme/app" })],
});
```

- [ ] **Step 5: Run protocol tests and confirm RED**

Run:

```bash
pnpm --filter worker exec vitest run src/repository-discovery/protocol.test.ts
```

Expected: FAIL because strict validation is absent.

- [ ] **Step 6: Implement protocol and selection decision**

Use a strict Zod schema. Return `discovery_needed` instead of immediately asking when multiple repositories exist without deterministic evidence. Exact paths, workflow-owned branches, PR-trigger repositories, and the only accessible repository remain mandatory deterministic selections.

- [ ] **Step 7: Run Task 1 tests**

```bash
pnpm --filter worker exec vitest run src/repository-discovery src/pre-sandbox/steps/repo-selection.test.ts src/lib/repo-allowlist.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/repository-discovery apps/worker/src/pre-sandbox/steps/repo-selection.ts apps/worker/src/pre-sandbox/steps/repo-selection.test.ts apps/worker/src/lib/repo-allowlist.ts apps/worker/src/lib/repo-allowlist.test.ts
git commit -m "feat: add bounded repository discovery"
```

### Task 2: Versioned trusted read/write workspace manifest

**Files:**
- Modify: `apps/worker/src/sandbox/repo-workspace.ts`
- Modify: `apps/worker/src/sandbox/repo-workspace.test.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.test.ts`
- Modify: `apps/worker/src/workflows/blocks/types.ts`

**Interfaces:**
- Produces: manifest V2 repositories with `access`, `researchBaseSha`, optional write branch baselines.
- Produces: `assertReadRepositoriesUnchanged(sandbox, manifest)`.
- Consumes: legacy manifest V1 through explicit compatibility parsing.

- [ ] **Step 1: Write failing manifest compatibility and access tests**

```ts
it("reads V1 as write-compatible legacy state and writes V2 explicitly", () => {
  expect(parseWorkspaceManifest(JSON.stringify(v1)).version).toBe(1);
  expect(buildWorkspaceManifest({ mode: "research", repositories: [repo] }))
    .toMatchObject({
      version: 2,
      repositories: [{ access: "read", researchBaseSha: undefined }],
    });
});

it("rejects publication when a read repository is dirty or ahead", async () => {
  await expect(assertReadRepositoriesUnchanged(sandbox, manifest))
    .rejects.toThrow("Read-only repository changed");
});
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/sandbox/repo-workspace.test.ts src/sandbox/trusted-workspace-publisher.test.ts
```

Expected: FAIL because only manifest V1 exists and access is implicit.

- [ ] **Step 3: Implement discriminated manifest versions**

```ts
const workspaceManifestV2Schema = z.object({
  version: z.literal(2),
  repositories: z.array(workspaceRepoV2Schema).max(8),
});

export const workspaceManifestSchema = z.discriminatedUnion("version", [
  workspaceManifestV1Schema,
  workspaceManifestV2Schema,
]);
```

Keep trusted JSON equality checks version-aware and fail closed on unsupported access.

- [ ] **Step 4: Implement read repository verifier**

For every V2 `read` repository, verify clean porcelain output and exact `HEAD === researchBaseSha`. This verifier runs before promotion, snapshot, implementation handoff, and any push.

- [ ] **Step 5: Run Task 2 tests**

```bash
pnpm --filter worker exec vitest run src/sandbox/repo-workspace.test.ts src/sandbox/trusted-workspace-publisher.test.ts src/workflows/blocks/finalize-workspace.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/sandbox/repo-workspace.ts apps/worker/src/sandbox/repo-workspace.test.ts apps/worker/src/sandbox/trusted-workspace-publisher.ts apps/worker/src/sandbox/trusted-workspace-publisher.test.ts apps/worker/src/workflows/blocks/types.ts
git commit -m "feat: add trusted repository access scopes"
```

### Task 3: Read-only provisioning, sandbox promotion, and repository attachment

**Files:**
- Create: `apps/worker/src/sandbox/research-workspace.ts`
- Create: `apps/worker/src/sandbox/research-workspace.test.ts`
- Modify: `apps/worker/src/sandbox/manager.ts`
- Modify: `apps/worker/src/sandbox/manager.test.ts`
- Modify: `apps/worker/src/workflows/blocks/prepare-workspace.ts`
- Modify: `apps/worker/src/workflows/blocks/prepare-workspace.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`

**Interfaces:**
- Produces: `attachResearchRepositories(input): Promise<WorkspaceManifestV2>`.
- Produces: `promoteAgentSandboxToWorkspace(ctx, sandboxId, state): void`.
- Consumes: selected catalog entries and trusted manifest V2.

- [ ] **Step 1: Write failing read-only provisioning tests**

Assert that research provisioning checks out default-branch heads and never calls `prepareSelectedRepositoryBranches`.

```ts
expect(mocks.prepareSelectedRepositoryBranches).not.toHaveBeenCalled();
expect(result.workspaceManifest.repositories[0]).toMatchObject({
  access: "read",
  branchName: undefined,
  researchBaseSha: "base-sha",
});
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/workflows/blocks/prepare-workspace.test.ts src/sandbox/manager.test.ts
```

Expected: FAIL because preparation currently creates remote branches and clones them.

- [ ] **Step 3: Implement read-only provisioning mode**

Add a `mode: "research" | "write"` input to the manager. Research clones the exact default head, records `researchBaseSha`, and does not create or check out a generated branch.

- [ ] **Step 4: Write failing attachment and replay tests**

Cover two-at-a-time clone concurrency, exact verified replay, partial clone cleanup, unexpected path, symlink, traversal, remote mismatch, and manifest atomicity.

- [ ] **Step 5: Run attachment tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/sandbox/research-workspace.test.ts
```

Expected: FAIL because dynamic attachment is absent.

- [ ] **Step 6: Implement idempotent attachment**

Clone into a server-chosen temporary path, verify origin and HEAD, atomically rename to the final path, then atomically replace the manifest. Use a concurrency limit of two without adding a new dependency.

- [ ] **Step 7: Write and implement scratch ownership-transfer test**

```ts
promoteAgentSandboxToWorkspace(ctx, "sbx-1", state);
expect(Object.values(ctx.agentSandboxIds)).not.toContain("sbx-1");
expect(ctx.sandboxId).toBe("sbx-1");
expect(ctx.sandboxIds.has("sbx-1")).toBe(true);
```

Ensure clarification scratch cleanup cannot detach the promoted sandbox.

- [ ] **Step 8: Run Task 3 tests**

```bash
pnpm --filter worker exec vitest run src/sandbox/research-workspace.test.ts src/sandbox/manager.test.ts src/workflows/blocks/prepare-workspace.test.ts src/workflows/planning-agent-provisioning.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/sandbox/research-workspace.ts apps/worker/src/sandbox/research-workspace.test.ts apps/worker/src/sandbox/manager.ts apps/worker/src/sandbox/manager.test.ts apps/worker/src/workflows/blocks/prepare-workspace.ts apps/worker/src/workflows/blocks/prepare-workspace.test.ts apps/worker/src/workflows/agent.ts
git commit -m "feat: provision read-only research workspaces"
```

### Task 4: Harness discovery and iterative planning in the shared workspace

**Files:**
- Create: `apps/worker/src/repository-discovery/runner.ts`
- Create: `apps/worker/src/repository-discovery/runner.test.ts`
- Modify: `apps/worker/src/sandbox/agents/types.ts`
- Modify: `apps/worker/src/sandbox/agents/claude.test.ts`
- Modify: `apps/worker/src/sandbox/agents/codex.test.ts`
- Modify: `apps/worker/src/sandbox/context.ts`
- Modify: `apps/worker/src/sandbox/context.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`
- Modify: `apps/worker/src/workflows/planning-agent-provisioning.test.ts`
- Modify: `apps/worker/src/workflows/clarification-snapshot-steps.ts`
- Modify: `apps/worker/src/workflows/clarification-snapshot-steps.test.ts`

**Interfaces:**
- Produces: `ResearchResult.status = "repositories_needed"` with exact requested repositories.
- Produces: `EngineCtx.repositoryExpansion` with round count and prior rationale.
- Consumes: discovery protocol, attachment, and the run default harness.

- [ ] **Step 1: Write failing research protocol tests**

```ts
expect(foldResearchOutput({
  status: "repositories_needed",
  body: "Shared tokens may live elsewhere",
  repositories: [{ provider: "gitlab", repoPath: "group/shared", rationale: "imports" }],
})).toMatchObject({ status: "repositories_needed" });
```

- [ ] **Step 2: Run protocol tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/sandbox/agents/claude.test.ts src/sandbox/agents/codex.test.ts
```

Expected: FAIL because the status and fields are not in `RESEARCH_SCHEMA`.

- [ ] **Step 3: Extend the strict research schema**

Add `repositories`, `writeRepositories`, and `repositoryEvidence`, preserving old completed/clarification/failed output parsing.

- [ ] **Step 4: Write failing shared-workspace planning tests**

Test V2 `prepare -> planning`, V1 planning-first implicit preparation, and that planning receives `ctx.sandboxId` instead of `ensurePlanningAgentSandboxForBlock`.

- [ ] **Step 5: Run planning tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/workflows/planning-agent-provisioning.test.ts
```

Expected: FAIL because planning always uses scratch.

- [ ] **Step 6: Execute planning in the shared workspace**

If no workspace exists, invoke idempotent preparation. Configure the node's exact harness runtime in `ctx.sandboxId`, set the commit guard to read-only, and preserve current prompt compilation.

- [ ] **Step 7: Implement discovery fallback and expansion loop**

Use the run default harness for metadata discovery. Validate every result server-side. For `repositories_needed`, enforce 2 rounds, 3 repositories per round, 8 total; attach and rerun with previous result in the prompt. Exceeding a limit returns targeted clarification.

- [ ] **Step 8: Add clarification restore regression tests**

Verify expansion counters, trusted manifest, all harness runtimes, and promoted sandbox ownership survive snapshot/restore.

- [ ] **Step 9: Run Task 4 tests**

```bash
pnpm --filter worker exec vitest run src/repository-discovery src/workflows/planning-agent-provisioning.test.ts src/workflows/clarification-snapshot-steps.test.ts src/sandbox/context.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/repository-discovery apps/worker/src/sandbox/agents/types.ts apps/worker/src/sandbox/agents/claude.test.ts apps/worker/src/sandbox/agents/codex.test.ts apps/worker/src/sandbox/context.ts apps/worker/src/sandbox/context.test.ts apps/worker/src/workflows/agent.ts apps/worker/src/workflows/planning-agent-provisioning.test.ts apps/worker/src/workflows/clarification-snapshot-steps.ts apps/worker/src/workflows/clarification-snapshot-steps.test.ts
git commit -m "feat: research across discovered repositories"
```

### Task 5: Ownership-safe write promotion

**Files:**
- Create: `apps/worker/src/workflows/repository-promotion.ts`
- Create: `apps/worker/src/workflows/repository-promotion.test.ts`
- Modify: `apps/worker/src/workflows/repository-prs.ts`
- Modify: `apps/worker/src/workflows/repository-prs.test.ts`
- Modify: `apps/worker/src/adapters/vcs/types.ts`
- Modify: `apps/worker/src/adapters/vcs/github.ts`
- Modify: `apps/worker/src/adapters/vcs/github.test.ts`
- Modify: `apps/worker/src/adapters/vcs/gitlab.ts`
- Modify: `apps/worker/src/adapters/vcs/gitlab.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`

**Interfaces:**
- Produces: `promoteRepositoryWriteScope(input): Promise<WorkspaceManifestV2>`.
- Produces: adapter `createBranchIfMissing` and `resetOwnedBranch` operations.
- Consumes: completed research write set and exact workflow-owned branch ledger.

- [ ] **Step 1: Write failing foreign-branch and clean-baseline tests**

```ts
await expect(promoteRepositoryWriteScope(inputWithForeignBranch))
  .rejects.toThrow("not owned by this ticket");
expect(vcs.resetOwnedBranch).not.toHaveBeenCalled();
```

Also reject dirty research repositories, moved default heads, unknown write repositories, and write sets above attached scope.

- [ ] **Step 2: Run promotion tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/workflows/repository-promotion.test.ts
```

Expected: FAIL because promotion does not exist.

- [ ] **Step 3: Split provider branch operations**

Replace ambiguous destructive `createBranch` behavior with explicit find/create/reset methods. GitHub 422 and GitLab “already exists” no longer authorize resets.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter worker exec vitest run src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts src/workflows/repository-prs.test.ts
```

Expected: PASS with foreign branches untouched.

- [ ] **Step 5: Implement promotion**

Verify all read baselines, establish ledger ownership before destructive mutation, create or reuse the exact branch, check it out with credentials supplied only to fetch, record `expectedRemoteSha` and `preAgentSha`, and atomically set `access: "write"`.

- [ ] **Step 6: Wire promotion after completed research**

Reject completed code-changing plans with an empty or invalid write set. Run implementation only after promotion succeeds.

- [ ] **Step 7: Run Task 5 tests**

```bash
pnpm --filter worker exec vitest run src/workflows/repository-promotion.test.ts src/workflows/repository-prs.test.ts src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts src/workflows/planning-agent-provisioning.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/workflows/repository-promotion.ts apps/worker/src/workflows/repository-promotion.test.ts apps/worker/src/workflows/repository-prs.ts apps/worker/src/workflows/repository-prs.test.ts apps/worker/src/adapters/vcs apps/worker/src/workflows/agent.ts
git commit -m "feat: promote explicit repository write scopes"
```

### Task 6: Publication safety for read and write repositories

**Files:**
- Modify: `apps/worker/src/workflows/workspace-publication.ts`
- Modify: `apps/worker/src/workflows/workspace-publication.test.ts`
- Modify: `apps/worker/src/workflows/blocks/finalize-workspace.ts`
- Modify: `apps/worker/src/workflows/blocks/finalize-workspace.test.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.test.ts`

**Interfaces:**
- Produces: publication preflight that validates all repos before pushing any.
- Consumes: manifest V2 access and trusted branch baselines.

- [ ] **Step 1: Write failing all-repository preflight tests**

Test that a changed read repository prevents every push, two changed write repositories yield two PRs, and unchanged promoted repositories yield no empty PR.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/workflows/workspace-publication.test.ts src/workflows/blocks/finalize-workspace.test.ts
```

Expected: FAIL because access mode is not enforced.

- [ ] **Step 3: Implement fail-before-first-push preflight**

Compute and validate every repository state first. Only after the complete preflight succeeds may changed `write` repositories be pushed in the existing trusted publication flow.

- [ ] **Step 4: Run Task 6 tests**

```bash
pnpm --filter worker exec vitest run src/workflows/workspace-publication.test.ts src/workflows/blocks/finalize-workspace.test.ts src/sandbox/trusted-workspace-publisher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/workflows/workspace-publication.ts apps/worker/src/workflows/workspace-publication.test.ts apps/worker/src/workflows/blocks/finalize-workspace.ts apps/worker/src/workflows/blocks/finalize-workspace.test.ts apps/worker/src/sandbox/trusted-workspace-publisher.ts apps/worker/src/sandbox/trusted-workspace-publisher.test.ts
git commit -m "feat: enforce repository access during publication"
```

### Task 7: Durable approved repository scope

**Files:**
- Create: `apps/worker/drizzle/0026_approval_repository_scope.sql`
- Modify: `apps/worker/drizzle/meta/_journal.json`
- Modify: generated Drizzle snapshot from `pnpm --filter worker db:generate`
- Modify: `apps/worker/src/db/approvals-schema.ts`
- Modify: `apps/worker/src/approvals/store.ts`
- Modify: `apps/worker/src/approvals/store.test.ts`
- Modify: `apps/worker/src/approvals/dispatch.ts`
- Modify: `apps/worker/src/approvals/dispatch.test.ts`
- Modify: `apps/worker/src/workflows/blocks/send-plan-approval.ts`
- Modify: `apps/worker/src/workflows/blocks/send-plan-approval.test.ts`
- Modify: `apps/worker/src/workflows/agent-input.ts`
- Modify: `apps/worker/src/workflows/agent-input.test.ts`

**Interfaces:**
- Produces: `ApprovedRepositoryScope`.
- Consumes: completed trusted research scope and pinned definition version.

- [ ] **Step 1: Write failing store and dispatch tests**

Persist read/write access, base SHA, default branch, and rationale; dispatch the same scope with the approved markdown. Verify legacy null scope remains readable.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter worker exec vitest run src/approvals/store.test.ts src/approvals/dispatch.test.ts src/workflows/blocks/send-plan-approval.test.ts src/workflows/agent-input.test.ts
```

Expected: FAIL because approvals persist only markdown and assumptions.

- [ ] **Step 3: Add JSONB scope migration and types**

```ts
repositoryScope: jsonb("repository_scope").$type<ApprovedRepositoryScope>(),
```

Generate the migration with the project command and inspect that it only adds the nullable column.

- [ ] **Step 4: Persist and dispatch exact scope**

Bind scope to the same definition id/version. On approved-run recreation, re-list access and compare every default head to `researchBaseSha`; stale scope returns a replan-required failure before implementation.

- [ ] **Step 5: Add stale/missing/off-allowlist tests**

Cover moved default branch, missing repository, changed allowlist, and legacy scope fallback.

- [ ] **Step 6: Run Task 7 tests**

```bash
pnpm --filter worker exec vitest run src/approvals src/workflows/blocks/send-plan-approval.test.ts src/workflows/agent-input.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/drizzle apps/worker/src/db/approvals-schema.ts apps/worker/src/approvals apps/worker/src/workflows/blocks/send-plan-approval.ts apps/worker/src/workflows/blocks/send-plan-approval.test.ts apps/worker/src/workflows/agent-input.ts apps/worker/src/workflows/agent-input.test.ts
git commit -m "feat: persist approved repository scopes"
```

### Task 8: End-to-end workflow coverage, observability, and verification

**Files:**
- Create: `apps/worker/src/workflows/multi-repo-research.test.ts`
- Modify: `apps/worker/src/run-observability/agent-observations.ts`
- Modify: `apps/worker/src/run-observability/agent-observations.test.ts`
- Modify: `docs/superpowers/specs/2026-07-23-aiw-147-multi-repo-research-design.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces complete workflow regression evidence and structured operational events.

- [ ] **Step 1: Write failing workflow scenarios**

Cover:

1. ambiguous ticket -> discovery -> planning in code;
2. repository Y symptom -> expansion to shared X -> write only X -> one PR;
3. changes in X and Y -> two PRs;
4. third expansion -> clarification;
5. PR trigger repository remains mandatory;
6. read repository mutation -> zero pushes;
7. mixed GitHub/GitLab identities remain provider-scoped.

- [ ] **Step 2: Run scenarios and confirm RED**

```bash
pnpm --filter worker exec vitest run src/workflows/multi-repo-research.test.ts
```

Expected: FAIL until complete orchestration is wired.

- [ ] **Step 3: Complete orchestration and telemetry**

Record catalog size, selection source/confidence, expansion counts, clone duration, read/write scope, stale approval reason, and PR count. Never log credentials or file contents.

- [ ] **Step 4: Run targeted feature suite**

```bash
pnpm --filter worker exec vitest run src/repository-discovery src/sandbox/research-workspace.test.ts src/workflows/multi-repo-research.test.ts src/workflows/repository-promotion.test.ts src/workflows/workspace-publication.test.ts src/approvals
```

Expected: PASS.

- [ ] **Step 5: Run static verification**

```bash
pnpm --filter worker typecheck
pnpm --filter worker validate:pre-sandbox
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Run the complete worker suite**

```bash
pnpm --filter worker test
```

Expected: all test files and tests pass with zero failures.

- [ ] **Step 7: Perform requirement audit**

Re-read the design and map each constraint, failure mode, security invariant, and test scenario to code plus a passing test. Do not mark complete while any row lacks evidence.

- [ ] **Step 8: Request independent code review**

Review the full range from `c53376c` to feature HEAD against this plan and the design. Fix every Critical and Important issue, rerun impacted tests, and repeat review if required.

- [ ] **Step 9: Commit final verification adjustments**

```bash
git add apps/worker/src/workflows/multi-repo-research.test.ts apps/worker/src/run-observability docs/superpowers/specs/2026-07-23-aiw-147-multi-repo-research-design.md
git commit -m "test: verify multi-repository research workflow"
```

