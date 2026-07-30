# Artur Release Notes Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an audited GitHub Actions pipeline that prepares non-technical Artur release notes, deploys one exact candidate to Artur, smoke-tests it, and publishes an immutable GitHub Release plus manifest.

**Architecture:** A dependency-light TypeScript tool under `scripts/release-notes` owns collection, classification, generation, rendering, validation, and manifest creation. `prepare-artur-release.yml` creates a reviewable docs-only pull request; `release-artur.yml` validates its immutable candidate, stages and promotes the worker/dashboard through Vercel, deploys the selected workflow definition through the existing worker API, then tags and publishes only after smoke tests pass.

**Tech Stack:** Node.js 24, TypeScript via `tsx`, Node test runner, Zod, YAML, GitHub CLI, GitHub Actions, Vercel CLI 52.0.0, existing worker workflow-definition API.

## Global Constraints

- A successful deployment to the protected `artur-production` environment is the source of truth that a release happened.
- Canonical notes live at `docs/releases/artur/<version>.md`.
- Versions use `YYYY.MM.PATCH`; files omit `v`, tags use `artur-v<version>`.
- Customer-facing copy is non-technical English.
- AI sees PR metadata only, never source diffs, secrets, or customer code.
- AI produces a draft; a human-approved release-note PR is mandatory.
- Every customer-facing bullet is traceable to one or more PR numbers.
- Tag and GitHub Release creation happen only after deployment and smoke success.
- Publication uses an immutable candidate SHA, never a mutable branch reference.
- No personal access tokens; the preparation PR uses a dedicated GitHub App token.
- Existing unrelated files and application behavior remain untouched.

---

### Task 1: Release-note domain, versioning, metadata extraction, and classification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/release-notes/types.ts`
- Create: `scripts/release-notes/classify.ts`
- Create: `scripts/release-notes/classify.test.ts`

**Interfaces:**
- Produces `ReleasePullRequest`, `ClassifiedPullRequest`, `ReleaseCategory`, `ReleaseCollection`, `ReleaseDraft`, and `ReleaseFileMetadata`.
- Produces `parseVersion(value): string`, `extractReleaseFields(body): ReleaseFields`, and `classifyPullRequest(pr): ClassificationResult`.

- [ ] **Step 1: Add the root test command and runtime validation dependencies**

Add root dev dependencies `tsx@^4.21.0`, `zod@^3.25.76`, and `yaml@^2.9.0`. Add:

```json
"test:release-notes": "node --import tsx --test \"scripts/release-notes/*.test.ts\"",
"release-notes": "node --import tsx scripts/release-notes/cli.ts"
```

Run `pnpm install --lockfile-only`.

- [ ] **Step 2: Write failing classification tests**

Cover:

```ts
parseVersion("2026.08.0") === "2026.08.0";
parseVersion("v2026.08.0") // throws
extractReleaseFields("## User impact\nFaster runs\n## Required action\nNone\n## Release note\nRuns finish faster.")
classifyPullRequest(prWithLabel("release:feature")).category === "feature";
classifyPullRequest(prWithLabels("release:feature", "release:fix")) // throws
classifyPullRequest(unlabelledFix).category === "fix"; // warning included
classifyPullRequest(internalPr).customerFacing === false;
classifyPullRequest(skippedPr).included === false;
```

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because `types.ts` and `classify.ts` do not exist.

- [ ] **Step 4: Implement the domain and classifier**

Use Zod for external JSON and version validation. Use the exact version regex:

```ts
export const releaseVersionSchema = z.string().regex(/^\d{4}\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/);
```

Classification precedence is explicit label, then `feat`/`fix` title inference, then customer metadata, then internal. More than one `release:*` label is invalid. Missing explicit metadata adds warnings without blocking normal PR merges.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/release-notes/types.ts scripts/release-notes/classify.ts scripts/release-notes/classify.test.ts
git commit -m "feat(release): classify Artur release changes"
```

### Task 2: Deterministic Git range and pull-request collection

**Files:**
- Create: `scripts/release-notes/collect.ts`
- Create: `scripts/release-notes/collect.test.ts`

**Interfaces:**
- Consumes `ReleasePullRequest`, `ClassifiedPullRequest`, and `ReleaseCollection`.
- Produces `collectRelease(options, deps): Promise<ReleaseCollection>`.
- `deps.run(command, args)` is injected in tests and uses `execFile` in production.

- [ ] **Step 1: Write failing collection tests**

Fixtures must prove:

- refs resolve to 40-character SHAs;
- `previousCommit` must be an ancestor of `targetCommit`;
- `gh pr list --state merged --limit 1000 --json ...` is called without a shell;
- only PR merge commits reachable from target and not reachable from previous are included;
- duplicate PR rows are removed by number;
- empty ranges and ranges without included changes fail clearly;
- internal and skipped PRs remain visible in the collection audit.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because `collect.ts` does not exist.

- [ ] **Step 3: Implement collection**

Resolve refs with:

```ts
git rev-parse --verify <ref>^{commit}
git merge-base --is-ancestor <previousSha> <targetSha>
```

Read PR metadata with `gh pr list`, parse with Zod, and check each `mergeCommit.oid` using `git merge-base --is-ancestor`. The collector returns sorted customer-facing, internal, and skipped arrays plus warnings and exact SHAs.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes/collect.ts scripts/release-notes/collect.test.ts
git commit -m "feat(release): collect exact Artur release scope"
```

### Task 3: AI draft, deterministic fallback, canonical Markdown, and validation

**Files:**
- Create: `scripts/release-notes/generate.ts`
- Create: `scripts/release-notes/render.ts`
- Create: `scripts/release-notes/generate.test.ts`
- Create: `scripts/release-notes/render.test.ts`

**Interfaces:**
- Consumes `ReleaseCollection`.
- Produces `generateReleaseDraft(collection, modelClient?): Promise<ReleaseDraft>`.
- Produces `renderReleaseNotes(collection, draft, version): string`.
- Produces `parseReleaseNotes(markdown): ParsedReleaseNotes`.
- Produces `extractShareableNotes(markdown): string`.
- Produces `validateReleaseNotes(markdown, expectedVersion): ValidationResult`.

- [ ] **Step 1: Write failing generation tests**

Assert that the prompt contains PR number/title/body/labels/release fields but no diff field. Validate model output shaped as:

```ts
{
  highlights: string,
  features: [{ text: string, sources: [123] }],
  improvementsAndFixes: [{ text: string, sources: [124] }],
  requiredAction: string,
  knownLimitations: string
}
```

Reject unknown sources, empty source arrays, unsupported sections, and technical/internal ticket copy. Prove AI failure returns a deterministic draft from `releaseNote` or `userImpact`.

- [ ] **Step 2: Write failing renderer tests**

Assert exact YAML metadata, `<!-- shareable:start -->` / `<!-- shareable:end -->`, source comments after every bullet, an exact-scope PR link for every included/internal PR, absence of skipped PRs from shareable copy, and byte-stable output.

- [ ] **Step 3: Run and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because generator and renderer do not exist.

- [ ] **Step 4: Implement structured generation**

The production client calls `POST https://api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY`, model `RELEASE_NOTES_MODEL || "claude-sonnet-4-6"`, `temperature: 0`, and a JSON-only prompt. Parse fenced or plain JSON, then validate with Zod. Never log the key, full prompt, or raw model response on failure.

- [ ] **Step 5: Implement rendering and validation**

The renderer owns all headings and links. Render source traceability as hidden comments:

```markdown
- Users can now...
  <!-- sources: 123,124 -->
```

Validation checks version/frontmatter, full SHAs, section order, bullet sources, known PR membership, and exact-scope completeness.

- [ ] **Step 6: Run focused tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/release-notes/generate.ts scripts/release-notes/render.ts scripts/release-notes/generate.test.ts scripts/release-notes/render.test.ts
git commit -m "feat(release): generate reviewable Artur release notes"
```

### Task 4: Preparation CLI, PR template, release documentation, and workflow

**Files:**
- Create: `scripts/release-notes/cli.ts`
- Create: `scripts/release-notes/cli.test.ts`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/workflows/prepare-artur-release.yml`
- Create: `docs/releases/artur/README.md`
- Create: `scripts/release-notes/workflows.test.ts`

**Interfaces:**
- Consumes Tasks 1–3.
- CLI command `prepare --version --previous-ref --target-ref main --repository --output`.
- Writes canonical notes and `.release-notes/artur-<version>-report.md`.

- [ ] **Step 1: Write failing CLI and workflow tests**

Use a temporary directory and injected dependencies to prove `prepare` writes the two expected files, rejects an existing release file, and uses the newest `artur-v*` tag only when `previous-ref` is omitted.

Parse the workflow with `yaml` and assert:

- manual inputs `version`, `previous_ref`, `dry_run`;
- trusted `main` checkout with read-only workflow permissions in the
  main-only `artur-release-preparation` environment;
- app-token creation uses `actions/create-github-app-token@v3`;
- dry-run uploads artifacts without pushing;
- non-dry-run creates `release/artur-<version>` and opens a PR;
- no `pull_request_target`, PAT, or unpinned arbitrary script is used.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because CLI/workflow/docs do not exist.

- [ ] **Step 3: Implement CLI and docs**

The report lists exact SHAs, included/internal/skipped PRs, warnings, and the Actions run URL. The PR template adds User impact, Required action, and Release note sections. `docs/releases/artur/README.md` documents locations, labels, secrets, dry run, review, and first-release base selection.

- [ ] **Step 4: Implement preparation workflow**

Use Node 24, pnpm 9.15.9, full Git history, `GH_TOKEN`, and an optional Anthropic secret. Dry run uses only `GITHUB_TOKEN`. PR creation requires:

```yaml
uses: actions/create-github-app-token@v3
with:
  app-id: ${{ secrets.RELEASE_BOT_APP_ID }}
  private-key: ${{ secrets.RELEASE_BOT_APP_PRIVATE_KEY }}
```

Commit only `docs/releases/artur/<version>.md`; upload the report as an artifact and use it as the PR body.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes/cli.ts scripts/release-notes/cli.test.ts scripts/release-notes/workflows.test.ts .github/PULL_REQUEST_TEMPLATE.md .github/workflows/prepare-artur-release.yml docs/releases/artur/README.md
git commit -m "feat(release): prepare Artur release note pull requests"
```

### Task 5: Candidate validation, manifest generation, and publication inputs

**Files:**
- Create: `scripts/release-notes/manifest.ts`
- Create: `scripts/release-notes/manifest.test.ts`
- Modify: `scripts/release-notes/cli.ts`
- Modify: `scripts/release-notes/cli.test.ts`

**Interfaces:**
- Adds CLI `validate --version --output`.
- Adds CLI `manifest --validation --worker-url --dashboard-url --workflow-version --test-run --approved-by --output`.
- Adds CLI `shareable --version --output`.

- [ ] **Step 1: Write failing candidate-validation tests**

Prove validation:

- finds the commit that added `docs/releases/artur/<version>.md`;
- matches metadata `targetCommit`;
- accepts only the release-note file in `git diff --name-only targetCommit..candidate`;
- rejects extra code/docs changes, reused tag, existing release, malformed source comments, or a candidate outside `main`;
- lists migration filenames from `previousCommit..targetCommit`.

- [ ] **Step 2: Write failing manifest tests**

Validate exact schema:

```json
{
  "version": "2026.08.0",
  "releasedAt": "ISO timestamp",
  "commit": "40-char SHA",
  "environment": "artur-production",
  "workerDeployment": { "url": "https://..." },
  "dashboardDeployment": { "url": "https://..." },
  "workflowDefinitionVersion": "12",
  "databaseMigrations": ["0037_example.sql"],
  "testRun": "https://github.com/...",
  "initiatedBy": "login",
  "productionApprovedBy": ["login"],
  "releaseNotesReview": {
    "pullRequest": 123,
    "approvedBy": ["login"]
  }
}
```

- [ ] **Step 3: Run and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because manifest and CLI commands do not exist.

- [ ] **Step 4: Implement validation and manifest commands**

Candidate lookup uses first-parent Git history for the file and records a JSON validation artifact. `shareable` extracts only marked content. Manifest timestamps are injected in tests and generated at execution in production.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test:release-notes`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-notes/manifest.ts scripts/release-notes/manifest.test.ts scripts/release-notes/cli.ts scripts/release-notes/cli.test.ts
git commit -m "feat(release): validate and record Artur deployments"
```

### Task 6: Protected Vercel deployment, workflow publication, smoke tests, and GitHub Release

**Files:**
- Create: `.github/workflows/release-artur.yml`
- Modify: `scripts/release-notes/workflows.test.ts`
- Modify: `docs/releases/artur/README.md`
- Modify: `SETUP.md`

**Interfaces:**
- Consumes candidate JSON and CLI commands from Task 5.
- Produces staged/promoted worker and dashboard URLs, deployed workflow version, manifest, tag, and GitHub Release.

- [ ] **Step 1: Extend failing workflow tests**

Assert the workflow:

- accepts only `version`;
- validates before entering `artur-production`;
- recollects the exact Git range and rejects scope/category drift in the
  reviewed Markdown;
- deploys the exact candidate to the non-production E2E Vercel project and
  runs the orchestration E2E against it before entering `artur-production`;
- has a single-release concurrency group;
- verifies every required secret/variable before Vercel mutation;
- checks out the immutable candidate;
- pins `vercel@52.0.0`;
- stages production builds with `--prod --skip-domain`;
- smoke-tests staged worker `/health` and dashboard `/login`;
- promotes both staged deployments;
- calls the existing workflow-definition GET/deploy API using `ARTUR_SESSION_TOKEN` and CAS values;
- smoke-tests production URLs;
- creates tag/release only after every prior step succeeds;
- attaches `release-manifest.json`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test:release-notes`

Expected: FAIL because `release-artur.yml` does not exist.

- [ ] **Step 3: Implement the release workflow**

Required `artur-production` environment configuration:

```text
Secrets:
  VERCEL_TOKEN
  ARTUR_SESSION_TOKEN
  VERCEL_AUTOMATION_BYPASS_SECRET

Variables:
  VERCEL_ORG_ID
  ARTUR_WORKER_PROJECT_ID
  ARTUR_DASHBOARD_PROJECT_ID
  ARTUR_WORKER_BASE_URL
  ARTUR_DASHBOARD_BASE_URL
  ARTUR_WORKFLOW_DEFINITION_ID
```

Use `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` to select each already-configured project. Store CLI stdout as the unique deployment URL. Send the protection-bypass header only when the secret is non-empty. Read workflow meta, POST its exact `expectedDraftRevision` and `expectedDeployedVersion`, and capture the returned immutable version.

Publish with:

```bash
gh release create "artur-v$VERSION" \
  --target "$CANDIDATE_SHA" \
  --title "AI Workflow — $VERSION" \
  --notes-file .release-notes/shareable.md \
  .release-notes/release-manifest.json
```

- [ ] **Step 4: Document environment setup and recovery**

Document that an owner session token must be refreshed before expiry, Vercel projects must already have production env/integrations, and a failed deployment creates no Git tag/release. Document how to inspect staged URLs and manually use Vercel rollback if promotion succeeded but later workflow publication failed; do not automate a broad rollback.

- [ ] **Step 5: Run workflow tests and type checks**

Run:

```bash
pnpm test:release-notes
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release-artur.yml scripts/release-notes/workflows.test.ts docs/releases/artur/README.md SETUP.md
git commit -m "feat(release): deploy and publish Artur releases"
```

### Task 7: Full verification and dry-run rehearsal

**Files:**
- Modify only files required by failures directly caused by Tasks 1–6.

**Interfaces:**
- Verifies the complete feature; produces no new public interface.

- [ ] **Step 1: Run release-note tests**

Run: `pnpm test:release-notes`

Expected: all release-note and workflow-contract tests pass.

- [ ] **Step 2: Run repository verification**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: exit 0; baseline was green before implementation.

- [ ] **Step 3: Run a local dry preparation against a known short range**

Use a temporary output directory and a real local Git range with `GH_TOKEN`:

```bash
pnpm release-notes prepare \
  --version 2026.08.0 \
  --previous-ref HEAD~2 \
  --target-ref HEAD \
  --repository Blazity/ai-workflow \
  --output /tmp/artur-release-dry-run
```

Expected: one canonical Markdown file and one preparation report; no branch, tag, release, deployment, or external write.

- [ ] **Step 4: Inspect the dry-run copy**

Confirm non-technical English, exact PR scope, source traceability, no secrets/diffs, and correct SHAs.

- [ ] **Step 5: Check repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: only planned commits and no generated dry-run files in the worktree.

- [ ] **Step 6: Final commit if verification required a scoped correction**

Commit only the correction and its regression test:

```bash
git add <exact corrected files>
git commit -m "fix(release): correct Artur release verification"
```
