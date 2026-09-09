# Artur Source Release and Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `Blazity/ai-workflow` so it prepares reviewed, non-technical Artur release notes and then opens a full-snapshot synchronization pull request in `Blazity/ai-workflow-arthur`, without deploying Artur production directly.

**Architecture:** The existing TypeScript release-note tooling remains responsible for scope collection, AI drafting, rendering, and approval validation. A new snapshot module copies every source-owned tracked path from an immutable source checkout into an Artur checkout, preserves only `.github/` and `renovate.json`, blocks unbackported Artur patches, and emits a machine-readable synchronization result consumed by GitHub Actions.

**Tech Stack:** Node.js 24, TypeScript via `tsx`, Node test runner, Zod, YAML, GitHub CLI, GitHub Actions, GitHub App installation tokens, Git.

## Global Constraints

- Canonical notes live at `docs/releases/artur/<version>.md` in both repositories.
- Versions use `YYYY.MM.PATCH`; filenames omit `v`, tags use `artur-v<version>`.
- Customer-facing copy is non-technical English.
- AI sees normalized pull-request metadata only, never source diffs, secrets, or customer code.
- The release-note pull request in `ai-workflow` is docs-only and requires approval.
- `targetSourceCommit` is immutable and excludes product commits merged after preparation.
- The Artur synchronization is a complete snapshot, not a partial cherry-pick.
- `.github/` and root `renovate.json` are the only destination-owned paths.
- `apps/*/vercel.json` and every other tracked path are source-owned.
- Artur-only application patches block synchronization until backported or reconciled.
- `ai-workflow` never invokes Artur's Vercel production deployment.
- Cross-repository credentials are short-lived and scoped to `ai-workflow-arthur` only.
- Checkout actions do not persist elevated Git credentials.
- Untrusted event values and workflow inputs are never interpolated directly into shell programs.

---

### Task 1: Align release metadata with the cross-repository contract

**Files:**
- Modify: `scripts/release-notes/types.ts`
- Modify: `scripts/release-notes/render.ts`
- Modify: `scripts/release-notes/render.test.ts`
- Modify: `scripts/release-notes/manifest.ts`
- Modify: `scripts/release-notes/manifest.test.ts`

**Interfaces:**
- Produces `ReleaseFileMetadata` with `version`, `previousSourceCommit`, `targetSourceCommit`, and `repository`.
- Produces `ApprovedSourceRelease` with `version`, `previousSourceCommit`, `targetSourceCommit`, `notesPath`, `releaseNotesPullRequest`, and `releaseNotesApprovedBy`.
- Produces `validateApprovedSourceRelease(input, deps): Promise<ApprovedSourceRelease>`.

- [ ] **Step 1: Change renderer tests to require source-specific front matter**

Update the expected header to:

```yaml
---
version: 2026.08.0
previousSourceCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
targetSourceCommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
repository: Blazity/ai-workflow
---
```

Add assertions that legacy `previousCommit` and `targetCommit` keys are rejected.

- [ ] **Step 2: Change approval-validation tests to allow main to advance**

Create a fixture where the docs-only release-note PR targets pinned product SHA `bbbb...`, but its merge commit also descends from a later unrelated product commit. Assert that validation succeeds because the PR's own file list contains only `docs/releases/artur/2026.08.0.md` and the immutable release scope still ends at `bbbb...`.

Also assert rejection when the reviewed PR changes a second file, lacks an approved review, or points to a `targetSourceCommit` not reachable from protected `main`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='metadata|approved source release'`

Expected: FAIL because the parser still expects `previousCommit` and candidate validation still requires `targetCommit..candidateCommit` to contain only the note.

- [ ] **Step 4: Implement the source-specific metadata and approval validator**

Change the public types to:

```ts
export interface ReleaseFileMetadata {
  version: string;
  previousSourceCommit: string;
  targetSourceCommit: string;
  repository: string;
}

export interface ApprovedSourceRelease {
  version: string;
  previousSourceCommit: string;
  targetSourceCommit: string;
  notesPath: string;
  releaseNotesPullRequest: number;
  releaseNotesApprovedBy: string[];
}
```

Rename `validateReleaseCandidate` to `validateApprovedSourceRelease`. Validate the release-note PR through `gh pr view ... --json number,state,mergedAt,baseRefName,reviewDecision,reviews,files`; validate the pinned source range independently through `collectRelease`. Do not use the merge commit as the deployable candidate.

- [ ] **Step 5: Run all release-note tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes/types.ts scripts/release-notes/render.ts scripts/release-notes/render.test.ts scripts/release-notes/manifest.ts scripts/release-notes/manifest.test.ts
git commit -m "refactor(release): pin Artur source release scope"
```

### Task 2: Add deterministic full-snapshot synchronization

**Files:**
- Create: `scripts/release-notes/sync.ts`
- Create: `scripts/release-notes/sync.test.ts`
- Modify: `scripts/release-notes/types.ts`

**Interfaces:**
- Produces `DESTINATION_OWNED_PATHS = [".github/", "renovate.json"]`.
- Produces `SyncInput`, `SyncResult`, and `SyncDeps`.
- Produces `synchronizeArturSnapshot(input, deps): Promise<SyncResult>`.

- [ ] **Step 1: Write a fixture that creates three temporary Git checkouts**

The test fixture creates:

```text
source-main/       approved note plus current main history
source-snapshot/   clean checkout at targetSourceCommit
destination/       clean checkout at ai-workflow-arthur/main
```

Populate them with a changed application file, a new binary fixture, an obsolete destination file, different `.github/workflows/ci.yml` files, and destination-only `renovate.json`.

- [ ] **Step 2: Write failing snapshot tests**

Assert that `synchronizeArturSnapshot`:

- copies changed and newly added source-owned files byte-for-byte;
- preserves executable modes and symbolic links;
- deletes the obsolete destination source-owned file;
- preserves the destination `.github/` tree and `renovate.json` byte-for-byte;
- ignores untracked files in every checkout;
- copies the approved note from `source-main`, even though it is not part of the pinned product snapshot;
- rejects a source checkout whose `HEAD` differs from `targetSourceCommit`;
- returns sorted `added`, `modified`, `deleted`, and `preserved` path arrays.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='Artur snapshot'`

Expected: FAIL because `sync.ts` does not exist.

- [ ] **Step 4: Implement tracked-file synchronization**

Use `git ls-files -z` in each checkout. Remove destination tracked source-owned paths that do not exist in the source snapshot, then copy source-owned tracked paths using `lstat`, `copyFile`, `chmod`, `readlink`, and `symlink`. Never traverse `.git`, and never use a shell-expanded path.

Use these public types:

```ts
export interface SyncInput {
  version: string;
  sourceMainDir: string;
  sourceSnapshotDir: string;
  destinationDir: string;
  approved: ApprovedSourceRelease;
}

export interface SyncResult {
  version: string;
  sourceCommit: string;
  destinationBaseCommit: string;
  notesPath: string;
  added: string[];
  modified: string[];
  deleted: string[];
  preserved: string[];
  driftCommits: string[];
}
```

After copying, use Git object hashes and file modes to prove every source-owned path matches the pinned source checkout and every destination-owned path matches the destination base.

- [ ] **Step 5: Run focused and full tests**

Run: `pnpm test:release-notes -- --test-name-pattern='Artur snapshot'`

Expected: PASS.

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes/types.ts scripts/release-notes/sync.ts scripts/release-notes/sync.test.ts
git commit -m "feat(release): build deterministic Artur snapshots"
```

### Task 3: Block unbackported Artur application patches

**Files:**
- Modify: `scripts/release-notes/sync.ts`
- Modify: `scripts/release-notes/sync.test.ts`

**Interfaces:**
- Produces `findUnbackportedDestinationCommits(input, deps): Promise<string[]>`.
- Consumes `previousDestinationRef`, source commit range, and the destination-owned path allowlist.

- [ ] **Step 1: Write failing drift tests**

Create temporary repositories with these histories:

```text
previous destination tag
├── destination `.github` commit                 allowed
├── destination application hotfix               blocked
└── destination application hotfix whose patch
    also exists in the current source range       allowed
```

Assert that merge commits are inspected through their non-merge children, patch-equivalent backports are accepted using stable Git patch IDs, and an invalid or non-ancestor destination baseline is rejected.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='destination drift'`

Expected: FAIL because drift detection is not implemented.

- [ ] **Step 3: Implement patch-equivalence detection**

List non-merge destination commits after `previousDestinationRef` that touch paths other than `.github/**` and `renovate.json`. Compute stable patch IDs without invoking a shell by piping `git show --pretty=format: <sha>` into a spawned `git patch-id --stable` process. Compare them with patch IDs from `previousSourceCommit..targetSourceCommit`.

Throw this actionable error when unmatched commits remain:

```text
Artur contains application commits that are not backported to the selected source snapshot: <sha list>
```

For the first release, require an explicitly configured, already reviewed `ARTUR_INITIAL_BASE_SHA`; after the first release, use the newest `artur-v*` destination tag.

- [ ] **Step 4: Run focused and full tests**

Run: `pnpm test:release-notes -- --test-name-pattern='destination drift'`

Expected: PASS.

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes/sync.ts scripts/release-notes/sync.test.ts
git commit -m "feat(release): guard Artur-only application drift"
```

### Task 4: Expose approval and synchronization through the CLI

**Files:**
- Modify: `scripts/release-notes/cli.ts`
- Modify: `scripts/release-notes/cli.test.ts`
- Modify: `scripts/release-notes/manifest.ts`
- Modify: `scripts/release-notes/manifest.test.ts`

**Interfaces:**
- CLI `validate-source --version --main-ref --output` writes `ApprovedSourceRelease` JSON.
- CLI `sync-artur --version --approval --source-main --source-snapshot --destination --previous-destination-ref --output` writes `SyncResult` JSON.
- CLI `shareable` remains unchanged.
- Removes the source-repository production `manifest` command.

- [ ] **Step 1: Write failing CLI tests**

Invoke `runCli(args, deps)` directly and assert exact argument validation, JSON output shape, missing-directory failures, invalid baseline failures, and non-zero errors without secret-bearing command output.

Use arguments shaped as:

```text
sync-artur
--version 2026.08.0
--approval .release-notes/approved-source.json
--source-main .release-sync/source-main
--source-snapshot .release-sync/source-snapshot
--destination .release-sync/destination
--previous-destination-ref artur-v2026.07.0
--output .release-notes/artur-sync.json
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='sync-artur CLI'`

Expected: FAIL because the command does not exist.

- [ ] **Step 3: Implement explicit command parsing and JSON outputs**

Move command selection into exported `runCli(argv, deps)`. Validate all paths and versions before calling Git or filesystem helpers. Keep subprocess calls on `execFile`/`spawn` argument arrays; do not construct shell command strings.

- [ ] **Step 4: Run focused and full tests**

Run: `pnpm test:release-notes -- --test-name-pattern='sync-artur CLI'`

Expected: PASS.

Run: `pnpm test:release-notes && pnpm typecheck:release-notes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes/cli.ts scripts/release-notes/cli.test.ts scripts/release-notes/manifest.ts scripts/release-notes/manifest.test.ts
git commit -m "feat(release): expose Artur synchronization CLI"
```

### Task 5: Replace direct deployment with a secure cross-repository workflow

**Files:**
- Delete: `.github/workflows/release-artur.yml`
- Create: `.github/workflows/sync-artur-release.yml`
- Modify: `.github/workflows/prepare-artur-release.yml`
- Modify: `scripts/release-notes/workflows.test.ts`

**Interfaces:**
- `prepare-artur-release.yml` still opens the reviewed docs-only source pull request.
- `sync-artur-release.yml` reacts to an added approved note on `main` and opens or updates `release/artur-<version>` in `ai-workflow-arthur`.
- The synchronization pull-request body contains a machine-readable `artur-release` JSON comment.

- [ ] **Step 1: Replace workflow contract tests before changing YAML**

Parse both workflows with `yaml` and assert:

- preparation token creation specifies `owner: Blazity` and `repositories: ai-workflow`;
- synchronization token creation specifies `owner: Blazity` and `repositories: ai-workflow-arthur`;
- every elevated checkout sets `persist-credentials: false`;
- workflow inputs enter scripts through `env`, never `${{ inputs.* }}` inside `run` scripts;
- both workflows use Node 24 and the repository pnpm version;
- synchronization is triggered only by new `docs/releases/artur/*.md` content on protected `main` and has a manual recovery dispatch;
- no source workflow contains `vercel deploy`, `VERCEL_PROJECT_ID`, `ARTUR_WORKER_URL`, or production environment secrets;
- no `pull_request_target` or personal access token is used.

- [ ] **Step 2: Run workflow tests and verify failure**

Run: `pnpm test:release-notes -- --test-name-pattern='workflow'`

Expected: FAIL because the source repository still contains direct Vercel deployment and broadly scoped App token creation.

- [ ] **Step 3: Secure the preparation workflow**

Pass `VERSION`, `PREVIOUS_REF`, and `TARGET_REF` only through environment variables. Scope the App token to `ai-workflow`, set checkout `persist-credentials: false`, and push with an ephemeral HTTP authorization header rather than changing the persisted remote URL.

- [ ] **Step 4: Implement `sync-artur-release.yml`**

The workflow performs these exact checkouts:

```text
.release-sync/source-main       ai-workflow/main containing the approved note
.release-sync/source-snapshot   ai-workflow at targetSourceCommit
.release-sync/destination       ai-workflow-arthur/main with full history and tags
```

It runs `validate-source`, resolves the newest destination `artur-v*` tag or `ARTUR_INITIAL_BASE_SHA`, runs `sync-artur`, commits in the destination checkout, pushes `release/artur-<version>`, and uses `gh pr create` or `gh pr edit` with the scoped App token.

Embed this parseable block in the pull-request body:

```html
<!-- artur-release
{"version":"2026.08.0","sourceCommit":"<40-sha>","sourcePullRequest":123}
-->
```

Upload `approved-source.json` and `artur-sync.json` as workflow artifacts. Set concurrency to `artur-sync-<version>` and never force-push a branch whose recorded source SHA differs.

- [ ] **Step 5: Run workflow and full static verification**

Run: `pnpm test:release-notes`

Expected: PASS.

Run: `pnpm typecheck:release-notes`

Expected: PASS.

Run: `/opt/homebrew/bin/rg -n 'vercel deploy|ARTUR_(WORKER|DASHBOARD)|VERCEL_PROJECT_ID' .github/workflows`

Expected: no Artur production deployment references in source workflows.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/prepare-artur-release.yml .github/workflows/sync-artur-release.yml .github/workflows/release-artur.yml scripts/release-notes/workflows.test.ts
git commit -m "feat(release): open Artur snapshot pull requests"
```

### Task 6: Update operator documentation and verify the source PR

**Files:**
- Modify: `docs/releases/artur/README.md`
- Modify: `SETUP.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Documents required GitHub App permissions, repository variables, the two-PR flow, recovery, and the initial drift baseline.

- [ ] **Step 1: Update release documentation**

Document this operator sequence exactly:

```text
Run Prepare Artur Release in ai-workflow
→ review and merge the notes PR
→ automation opens the snapshot PR in ai-workflow-arthur
→ review CI and Vercel Preview there
→ merge the Artur PR to deploy production
```

List `RELEASE_BOT_APP_ID`, `RELEASE_BOT_APP_PRIVATE_KEY`, optional `ANTHROPIC_API_KEY`, optional `RELEASE_NOTES_MODEL`, and first-release `ARTUR_INITIAL_BASE_SHA`. State that the App installation needs contents/pull-request write access only to the two named repositories.

- [ ] **Step 2: Run the complete source verification**

Run: `pnpm test:release-notes`

Expected: PASS.

Run: `pnpm typecheck:release-notes`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `git diff --check origin/main...HEAD`

Expected: no output.

- [ ] **Step 3: Review the final source diff**

Confirm the diff contains release-note preparation and synchronization only, contains no Vercel production deployment commands, and does not modify application runtime behavior.

- [ ] **Step 4: Commit**

```bash
git add docs/releases/artur/README.md SETUP.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs(release): explain the two-repository Artur flow"
```

- [ ] **Step 5: Push and update PR #193**

Push `feat/artur-release-notes-pipeline`, update the PR title/body to describe the two-repository boundary, link AWT-1051, and request a new CodeRabbit review. Do not merge while required checks or review threads remain unresolved.
