# Artur Destination Validation and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Blazity/ai-workflow-arthur` independently validate snapshot pull requests, deploy through its existing Vercel Git integration after merge, smoke-test the exact production commit, and publish an immutable Artur GitHub Release.

**Architecture:** Destination-owned scripts live under `.github/scripts/`, which is excluded from source snapshot replacement. A pull-request workflow independently fetches the pinned source SHA and checks tree equality; a post-merge workflow polls the two existing Vercel commit-status contexts, smoke-tests configured production URLs, and publishes the tag, GitHub Release, and manifest only after success.

**Tech Stack:** Node.js 24, native Node test runner, GitHub Actions, GitHub CLI/API, existing Vercel Git integration, Git.

## Global Constraints

- `.github/` and root `renovate.json` remain owned by `ai-workflow-arthur`.
- Every other tracked path matches the approved `ai-workflow` snapshot, plus the copied approved note.
- The required Vercel status contexts are `Vercel – ai-workflow-arthur` and `Vercel – ai-workflow-arthur-dashboard`.
- Production starts only after merge to protected `ai-workflow-arthur/main`.
- The destination workflow observes Vercel deployment; it does not run `vercel deploy`.
- Worker smoke test is `GET <ARTUR_WORKER_URL>/health` and requires `{ "status": "ok" }`.
- Dashboard smoke test is `GET <ARTUR_DASHBOARD_URL>/` and requires an HTTP success response.
- Tag format is `artur-v<YYYY.MM.PATCH>` and points to the exact Artur merge SHA.
- GitHub Release copy is byte-derived from the reviewed Markdown in the Artur repository.
- A failed deployment or smoke test creates neither tag nor GitHub Release.

---

### Task 1: Add a destination-owned release contract parser

**Files:**
- Create: `.github/scripts/artur-release-contract.mjs`
- Create: `.github/scripts/artur-release-contract.test.mjs`

**Interfaces:**
- Produces `parseReleaseMetadata(markdown): ReleaseMetadata`.
- Produces `parseSyncPullRequestBody(body): SyncPullRequestMetadata`.
- Produces `findAddedReleaseNote(diffRows): string`.
- Produces `extractShareableNotes(markdown): string`.

- [ ] **Step 1: Write failing parser tests**

Cover the exact release front matter:

```js
{
  version: "2026.08.0",
  previousSourceCommit: "a".repeat(40),
  targetSourceCommit: "b".repeat(40),
  repository: "Blazity/ai-workflow"
}
```

Reject unknown repositories, non-calendar versions, abbreviated SHAs, missing shareable markers, more than one added release note, modified existing release notes, and malformed `<!-- artur-release ... -->` JSON.

- [ ] **Step 2: Run and verify failure**

Run: `node --test .github/scripts/artur-release-contract.test.mjs`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement the parser without dependencies**

Use native string parsing and `JSON.parse`; do not install packages in the destination-owned area. Return frozen plain objects and require the pull-request metadata version/source SHA to equal the Markdown metadata.

- [ ] **Step 4: Run the focused test**

Run: `node --test .github/scripts/artur-release-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/artur-release-contract.mjs .github/scripts/artur-release-contract.test.mjs
git commit -m "feat(release): parse Artur synchronization contracts"
```

### Task 2: Independently validate snapshot pull requests

**Files:**
- Create: `.github/scripts/validate-artur-snapshot.mjs`
- Create: `.github/scripts/validate-artur-snapshot.test.mjs`
- Create: `.github/workflows/validate-artur-release.yml`

**Interfaces:**
- Produces `validateSnapshot({ sourceDir, destinationDir, notesPath }): SnapshotValidation`.
- CLI accepts `--source`, `--destination`, `--notes`, and `--output`.
- Workflow check name is `Validate Artur release snapshot`.

- [ ] **Step 1: Write failing tree-validation tests**

Build temporary Git repositories and prove that validation:

- accepts byte-identical source-owned files;
- accepts destination-specific `.github/**` and `renovate.json`;
- accepts the approved note copied from source `main`;
- rejects missing, extra, content-different, executable-mode-different, and symlink-different source-owned paths;
- ignores untracked files;
- emits sorted mismatch arrays in JSON.

- [ ] **Step 2: Run and verify failure**

Run: `node --test .github/scripts/validate-artur-snapshot.test.mjs`

Expected: FAIL because validation does not exist.

- [ ] **Step 3: Implement Git-index-based comparison**

Use `git ls-files -s -z` to compare blob IDs and modes after computing hashes for destination files with `git hash-object`. Exclude exactly `.github/**`, `renovate.json`, and the one approved note path. Compare the note byte-for-byte with the source-main checkout.

- [ ] **Step 4: Write the pull-request workflow**

On pull requests to `main`, the workflow:

1. checks out the Artur PR with `persist-credentials: false`;
2. reads the machine-readable PR metadata and release-note front matter;
3. creates a short-lived GitHub App token scoped to `Blazity/ai-workflow` with contents read permission;
4. checks out `targetSourceCommit` into `.release-validation/source-snapshot`;
5. checks out source `main` into `.release-validation/source-main` to obtain the approved note;
6. runs the contract parser and tree validator;
7. uploads validation JSON as an artifact.

Pull requests without an added Artur release note exit successfully after reporting that they are ordinary Artur maintenance changes. A pull request containing the release marker must pass the complete contract.

- [ ] **Step 5: Run local tests and YAML syntax validation**

Run: `node --test .github/scripts/*.test.mjs`

Expected: PASS.

Run: `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/validate-artur-release.yml", aliases: true)'`

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/validate-artur-snapshot.mjs .github/scripts/validate-artur-snapshot.test.mjs .github/workflows/validate-artur-release.yml
git commit -m "feat(release): validate Artur snapshot pull requests"
```

### Task 3: Observe exact Vercel deployments and smoke-test production

**Files:**
- Create: `.github/scripts/publish-artur-release.mjs`
- Create: `.github/scripts/publish-artur-release.test.mjs`

**Interfaces:**
- Produces `waitForCommitStatuses(input, deps): Promise<VercelEvidence>`.
- Produces `smokeTestProduction(input, deps): Promise<SmokeEvidence>`.
- Produces `createReleaseManifest(input): object`.
- CLI command `observe` writes `.release-notes/deployment-evidence.json`.
- CLI command `manifest` writes `.release-notes/release-manifest.json` and `.release-notes/shareable.md`.

- [ ] **Step 1: Write failing status-polling tests**

Mock GitHub combined-status responses and assert:

- polling waits until both required contexts report `success` for the exact destination SHA;
- `failure` or `error` stops immediately;
- `pending` continues with bounded polling;
- a 30-minute deadline produces a timeout error listing missing contexts;
- status target URLs are preserved in evidence;
- statuses attached to another SHA are never accepted.

- [ ] **Step 2: Write failing smoke and manifest tests**

Mock `fetch` and assert:

- worker `/health` must return HTTP 200 and JSON `{ status: "ok" }`;
- dashboard `/` must return a 2xx response after redirects;
- malformed URLs are rejected before network access;
- manifest includes version, source/destination repositories and SHAs, both PR numbers, both production URLs, both status URLs, test run URL, and ISO timestamp;
- shareable Markdown is byte-derived from the checked-in note.

- [ ] **Step 3: Run and verify failure**

Run: `node --test .github/scripts/publish-artur-release.test.mjs`

Expected: FAIL because publication helpers do not exist.

- [ ] **Step 4: Implement bounded observation and smoke testing**

Query:

```text
gh api repos/Blazity/ai-workflow-arthur/commits/<destination-sha>/status
```

Require these exact contexts:

```js
[
  "Vercel – ai-workflow-arthur",
  "Vercel – ai-workflow-arthur-dashboard",
]
```

Use `AbortSignal.timeout(30_000)` for each HTTP smoke request. Redact query strings and credentials from thrown URL errors.

- [ ] **Step 5: Implement manifest and shareable output**

Emit this stable top-level shape:

```js
{
  version,
  releasedAt,
  sourceRepository: "Blazity/ai-workflow",
  sourceCommit,
  destinationRepository: "Blazity/ai-workflow-arthur",
  destinationCommit,
  releaseNotesPullRequest,
  synchronizationPullRequest,
  dashboardDeployment: { url, statusUrl },
  workerDeployment: { url, statusUrl },
  testRun
}
```

- [ ] **Step 6: Run the focused tests**

Run: `node --test .github/scripts/publish-artur-release.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add .github/scripts/publish-artur-release.mjs .github/scripts/publish-artur-release.test.mjs
git commit -m "feat(release): observe and verify Artur production"
```

### Task 4: Publish the Artur tag and GitHub Release after deployment

**Files:**
- Create: `.github/workflows/publish-artur-release.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Publication is triggered by a push to `main` that adds one `docs/releases/artur/*.md` file.
- Uses repository variables `ARTUR_WORKER_URL` and `ARTUR_DASHBOARD_URL`.
- Publishes `artur-v<version>` at `${{ github.sha }}`.

- [ ] **Step 1: Add destination script tests to CI**

Add this step to the existing `ci` job before project tests:

```yaml
- name: Test destination-owned release automation
  run: node --test .github/scripts/*.test.mjs
```

- [ ] **Step 2: Create the publication workflow**

Use permissions `contents: write`, `pull-requests: read`, and `statuses: read`. Set concurrency group `artur-production-release` with `cancel-in-progress: false`.

The workflow:

1. checks out exact `${{ github.sha }}` with full history and `persist-credentials: false`;
2. requires exactly one added release-note file in `${{ github.event.before }}..${{ github.sha }}`;
3. finds the merged synchronization PR through `repos/.../commits/${{ github.sha }}/pulls`;
4. parses the PR marker and confirms source SHA/version equality with the note;
5. polls both exact Vercel status contexts;
6. smoke-tests `vars.ARTUR_WORKER_URL` and `vars.ARTUR_DASHBOARD_URL`;
7. generates shareable Markdown and the manifest;
8. rejects an existing `artur-v<version>` tag or GitHub Release;
9. creates the tag and release with `gh release create --target "${GITHUB_SHA}" --notes-file ... release-manifest.json`;
10. uploads evidence artifacts and writes all links to the job summary.

Pass all event values through environment variables. No `${{ github.event.* }}` expression appears directly inside a `run` script.

- [ ] **Step 3: Add a failure-path workflow test**

Extend `publish-artur-release.test.mjs` with a fixture proving that failed Vercel status and failed smoke response both prevent the mocked `gh release create` call.

- [ ] **Step 4: Run destination tests and YAML parsing**

Run: `node --test .github/scripts/*.test.mjs`

Expected: PASS.

Run: `ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |f| YAML.load_file(f, aliases: true) }'`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/publish-artur-release.yml .github/scripts/publish-artur-release.test.mjs
git commit -m "feat(release): publish verified Artur releases"
```

### Task 5: Document configuration, rehearse, and open the destination PR

**Files:**
- Modify: `SETUP.md`

**Interfaces:**
- Documents destination GitHub App access, repository variables, required status contexts, branch protection, reruns, and the no-direct-deploy guarantee.

- [ ] **Step 1: Document destination configuration**

Add:

- `RELEASE_BOT_APP_ID` and `RELEASE_BOT_APP_PRIVATE_KEY`, with contents read access scoped to `Blazity/ai-workflow`;
- `ARTUR_WORKER_URL` and `ARTUR_DASHBOARD_URL` repository variables;
- required PR checks `CI` and `Validate Artur release snapshot`;
- required Vercel contexts `Vercel – ai-workflow-arthur` and `Vercel – ai-workflow-arthur-dashboard`;
- confirmation that both Vercel projects use `ai-workflow-arthur/main` as production source;
- rerun guidance for a deployment that succeeded after the publication workflow timed out.

- [ ] **Step 2: Run complete destination verification**

Run: `node --test .github/scripts/*.test.mjs`

Expected: PASS.

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`

Expected: PASS.

Run: `git diff --check origin/main...HEAD`

Expected: no output.

- [ ] **Step 3: Rehearse against the current production status API without publishing**

Run the `observe` CLI against a known current Artur `main` SHA and confirm it resolves both named Vercel status contexts. Run smoke requests against configured production URLs. Do not create a tag or GitHub Release during this rehearsal.

- [ ] **Step 4: Commit**

```bash
git add SETUP.md
git commit -m "docs(release): configure Artur-owned publication"
```

- [ ] **Step 5: Push and open the destination setup PR**

Push the isolated Artur worktree branch, open a pull request into `ai-workflow-arthur/main`, link AWT-1051 and source PR #193, and describe that this PR changes repository-owned CI/publication only. Do not merge until checks and review pass.
