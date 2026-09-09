# Artur Cross-Repository Release Pipeline Design

**Date:** 2026-08-03
**Status:** Approved

## Goal

Build a repeatable Artur release process that:

1. generates release notes understandable to non-technical Artur employees;
2. requires a reviewed release-notes pull request in `Blazity/ai-workflow`;
3. synchronizes the complete approved application snapshot into the separately
   deployed `Blazity/ai-workflow-arthur` repository;
4. requires a second pull request in `ai-workflow-arthur` before production;
5. preserves only explicitly destination-owned repository configuration;
6. records the exact source and destination commits used for the release.

The first release must cover the changes made since Zak's last product review
and bring the Artur repository up to the complete selected source snapshot.

## Repository Responsibilities

### `Blazity/ai-workflow`

The main repository is the source of truth for:

- application code;
- database migrations;
- shared Vercel application configuration such as `apps/*/vercel.json`;
- release-note generation and validation;
- the canonical release-note Markdown files;
- the exact source commit selected for an Artur release;
- automation that opens the synchronization pull request in the Artur
  repository.

It does not deploy Artur production directly and does not own Artur's Vercel
project identifiers or production deployment credentials.

### `Blazity/ai-workflow-arthur`

The Artur repository is the source of truth for:

- its `.github/` directory, including CI and release-publication automation;
- its root `renovate.json`;
- the branch and pull-request gate immediately before Artur production;
- the Git commit connected to Artur's Vercel projects;
- the Artur Git tag, GitHub Release, deployment evidence, and smoke-test result.

The Vercel Git integration remains connected to this repository. A merge to
its protected `main` branch is the event that starts the production deployment.

## Key Decisions

- Every release uses two reviewed pull requests.
- The first pull request approves wording and scope in `ai-workflow`.
- Merging the first pull request automatically opens the second pull request in
  `ai-workflow-arthur`.
- The second pull request contains a complete application snapshot, not only
  the commits mentioned in the release notes.
- The snapshot is pinned to an immutable full source SHA selected during
  preparation.
- `.github/` and `renovate.json` are the only destination-owned paths preserved
  during synchronization.
- All other tracked paths, including `apps/*/vercel.json`, match the source
  snapshot.
- Merging the Artur pull request is the explicit production approval.
- Vercel deploys from the Artur repository; the main repository never deploys
  to Artur directly.
- The same reviewed Markdown is committed in both repositories and used for
  the GitHub Release.
- AI drafts customer-facing copy from pull-request metadata. A person remains
  responsible for the final wording.

## Non-goals

- Deploying Artur after every ordinary merge to `ai-workflow`.
- Maintaining arbitrary Artur-only application changes indefinitely.
- Force-pushing or mirroring Git history between the repositories.
- Replacing Vercel's existing Git integration.
- Building a general multi-customer release platform in this increment.
- Publishing release notes without human review.
- Sending release announcements to email or Slack automatically.

## Considered Synchronization Approaches

### 1. Full snapshot with destination-owned exceptions

Materialize the complete tree from an immutable `ai-workflow` commit in a
branch based on `ai-workflow-arthur/main`, delete obsolete source-owned files,
then restore `.github/` and `renovate.json` from the Artur base branch.

This is the selected approach. It makes application state deterministic while
keeping repository-specific CI and dependency automation separate.

### 2. Git merge between the repositories

Merge source history into the Artur branch. This preserves Artur-only patches,
but also preserves accidental drift and makes it progressively harder to know
whether Artur runs the same application as the main repository.

### 3. Deploy a prebuilt artifact

Build once in the main repository and promote the artifact to Artur. This is a
valid longer-term direction, but it would replace the current Vercel Git model
and materially expand the scope of this release-notes project.

## Release Note Contract

The canonical file in the main repository is:

```text
docs/releases/artur/<version>.md
```

The synchronization pull request copies it to the identical path in the Artur
repository. Versions use calendar version numbers in `YYYY.MM.PATCH` form,
for example `2026.08.0`. The Artur tag is `artur-v2026.08.0`.

Each file contains immutable scope metadata and reviewed copy:

```markdown
---
version: 2026.08.0
previousSourceCommit: full-base-sha
targetSourceCommit: full-target-sha
---

# AI Workflow — 2026.08.0

## Highlights

A short explanation of the release's value.

## What's new

- Customer-facing capabilities.

## Improvements and fixes

- User-visible reliability and usability improvements.

## Do you need to do anything?

Explicit actions, or a statement that no action is required.

## Known limitations

Only limitations relevant to Artur users.

## Exact release scope

- Technical pull-request links and classifications.
```

The first five sections are shareable. The exact-scope section remains in the
file for review and audit. The renderer owns headings and shareable markers;
the AI does not emit arbitrary Markdown.

## Pull Request Metadata

The main repository's pull-request template supplies:

```markdown
## User impact

What can a user do now, or what works better for them?

## Required action

Does a user or administrator need to do anything after release?

## Release note

One non-technical sentence, or `internal`.
```

Release classification labels are:

- `release:feature`
- `release:improvement`
- `release:fix`
- `release:internal`
- `release:skip`

Ordinary pull requests are not blocked for missing metadata. Preparing a
customer release reports missing metadata, and the release cannot progress
until every customer-facing bullet is traceable to reviewed source pull
requests.

## Stage 1: Prepare and Approve Release Notes

An authorized team member starts:

```text
ai-workflow → Actions → Prepare Artur Release → Run workflow
```

Inputs are:

- `version`: required `YYYY.MM.PATCH` value;
- `previous_ref`: optional for the first release, then derived from the latest
  published Artur release metadata;
- `target_ref`: defaults to protected `ai-workflow/main` and is immediately
  resolved to a full SHA;
- `dry_run`: creates artifacts without a branch or pull request.

The workflow:

1. validates the version as data before it reaches any shell command;
2. resolves the previous and target source references to full SHAs;
3. rejects an existing version, note file, Artur branch, tag, or open release
   pull request;
4. collects and classifies pull requests in the exact source range;
5. generates structured, non-technical English copy from pull-request
   metadata;
6. validates that every customer-facing bullet cites at least one included
   pull request;
7. writes `docs/releases/artur/<version>.md` with the pinned source SHAs;
8. opens a docs-only pull request in `ai-workflow`;
9. publishes a preparation report containing included, internal, skipped, and
   missing-metadata groups.

The reviewer may edit the Markdown normally. Merging this pull request approves
the release wording and immutable application SHA. Product commits merged after
the pinned `targetSourceCommit` are not silently included; they belong to a
later release unless preparation is rerun.

## Stage 2: Create the Artur Synchronization Pull Request

A workflow in `ai-workflow` reacts only when a new approved Artur release-note
file is merged into protected `main`.

It:

1. checks that the source note came from one merged, reviewed, docs-only pull
   request;
2. validates the note schema, version, source range, and pull-request scope;
3. mints a short-lived GitHub App token scoped only to
   `Blazity/ai-workflow-arthur`;
4. creates `release/artur-<version>` from the current protected Artur `main`;
5. materializes every tracked source-owned path from
   `targetSourceCommit`;
6. deletes source-owned paths that no longer exist in that source snapshot;
7. restores `.github/` and `renovate.json` byte-for-byte from the Artur base;
8. copies the approved release-note file from source `main` to the identical
   destination path;
9. verifies the resulting tree against the pinned source snapshot, applying
   only the two documented exceptions and the newly approved note;
10. commits the snapshot with the source SHA in the commit message;
11. opens a pull request in `ai-workflow-arthur`.

The second pull request includes:

- the version;
- the exact source SHA;
- the Artur base SHA;
- links to the release-note pull request and generation run;
- the full reviewed release notes;
- a summary of added, changed, and deleted files;
- an explicit report that destination-owned paths were preserved;
- any Artur-only application drift detected before synchronization.

The workflow is idempotent for a version. A safe rerun updates the existing
release branch and pull request when they still represent the same immutable
source SHA; it never rewrites an already published release.

## Artur Drift and Hotfix Policy

Application hotfixes may be developed in `ai-workflow-arthur` when necessary,
but they must be backported to `ai-workflow` before the next release snapshot.

Before opening the synchronization pull request, the pipeline compares Artur
application commits since the previous Artur release with the selected source
snapshot. A destination-only application patch that is not patch-equivalent in
the source blocks automatic synchronization. It must be backported or manually
reconciled; the pipeline does not silently discard it.

The initial rollout requires a one-time reconciliation because the existing
Artur branch contains several commits that are not patch-identical to current
source history. Functional equivalence must be reviewed before the first full
snapshot replaces those files.

Changes limited to `.github/` and `renovate.json` are expected destination
changes and do not count as application drift.

## Stage 3: Validate and Deploy from the Artur Repository

The Artur synchronization pull request runs destination-owned CI and the
existing Vercel Preview integration. Required checks include:

- synchronization contract validation;
- type checking and unit tests;
- relevant workflow and orchestration tests;
- verification that `.github/` and `renovate.json` match the Artur base;
- verification that all other tracked application paths match the pinned
  source snapshot;
- preview smoke testing against the Artur-connected projects when available.

Merging the second pull request to protected `ai-workflow-arthur/main` is the
production approval. The merge causes the existing Vercel Git integration to
deploy the dashboard and worker from the Artur merge commit. No workflow in
`ai-workflow` invokes Vercel production APIs.

A destination-owned publication workflow then:

1. detects the one newly merged Artur release-note file;
2. waits for both Vercel production deployments associated with the exact
   Artur merge SHA;
3. runs deployed smoke tests;
4. creates `artur-v<version>` at the exact Artur merge SHA;
5. creates the GitHub Release in `ai-workflow-arthur` from the shareable
   sections of the copied Markdown;
6. attaches a generated release manifest;
7. records deployment, test, source-PR, synchronization-PR, source-SHA, and
   Artur-SHA links in the job summary.

The tag and GitHub Release are created only after both production deployments
and smoke tests succeed.

## Release Manifest

The publication workflow generates `release-manifest.json` and attaches it to
the Artur GitHub Release. It records at least:

```json
{
  "version": "2026.08.0",
  "sourceRepository": "Blazity/ai-workflow",
  "sourceCommit": "full-source-sha",
  "destinationRepository": "Blazity/ai-workflow-arthur",
  "destinationCommit": "full-artur-sha",
  "releaseNotesPullRequest": 123,
  "synchronizationPullRequest": 456,
  "dashboardDeployment": {
    "url": "https://deployment.example"
  },
  "workerDeployment": {
    "url": "https://deployment.example"
  },
  "testRun": "https://github.com/Blazity/ai-workflow-arthur/actions/runs/id",
  "releasedAt": "2026-08-03T10:00:00Z"
}
```

The manifest is attached rather than committed after deployment so the
deployed Artur commit remains identical to the tagged commit.

## Failure Handling

- Invalid or reused version: stop before generation.
- Missing first-release base: require an explicitly reviewed source reference.
- Empty source range: stop without creating an empty release.
- AI failure or invalid output: render a deterministic draft from normalized
  metadata and mark it for human rewrite.
- Release-note validation failure: do not create either release pull request.
- Unreviewed or non-docs source pull request: do not synchronize.
- Artur-only application drift: stop and require backport or reconciliation.
- Existing destination branch with a different source SHA: stop without
  overwriting it.
- Snapshot mismatch: stop before pushing the destination branch.
- Destination CI or preview failure: block merge to Artur `main`.
- Production deployment or smoke-test failure: do not create a tag or GitHub
  Release; retain deployment evidence for diagnosis.
- Existing destination tag or release: stop without overwriting immutable
  release history.

## Security and Permissions

- Workflows use least-privilege `GITHUB_TOKEN` permissions.
- The cross-repository GitHub App token is short-lived and explicitly scoped
  to `Blazity/ai-workflow-arthur`; it is not minted for all installation
  repositories.
- Checkouts used with elevated credentials set persisted Git credentials off.
- Untrusted workflow inputs and GitHub event values are passed through
  validated environment variables or action inputs, never interpolated
  directly into shell programs.
- The source workflow has no Artur Vercel production credentials.
- Artur deployment observation and publication run only in the destination
  repository after merge to protected `main`.
- AI input contains normalized pull-request metadata, not source-code diffs,
  repository secrets, or customer code.
- Actions and scripts use the repository's declared Node and package-manager
  versions.
- Release publication always uses immutable source and destination SHAs.

## Testing Strategy

### Unit tests

- version, front matter, and immutable SHA validation;
- pull-request collection and range boundaries;
- release classification and traceability;
- structured AI output and deterministic fallback;
- Markdown rendering and shareable-section extraction;
- snapshot allowlist and obsolete-file deletion;
- preservation of `.github/` and `renovate.json`;
- destination tree comparison;
- Artur-only drift detection;
- idempotent branch and pull-request behavior.

### Workflow tests

- preparation `dry_run` against a known source range;
- destination sync against temporary fixture repositories;
- forced mismatch showing that synchronization stops before push;
- forced destination-only hotfix showing that drift blocks the release;
- rerun for the same version and SHA without duplicate pull requests;
- Artur preview rehearsal without merging to production;
- production publication rehearsal with tag and GitHub Release creation
  suppressed.

### Release acceptance

A release is accepted only when:

- the source release-note pull request was reviewed and merged;
- the Artur synchronization pull request was reviewed and merged;
- all source-owned destination paths match the pinned source snapshot;
- only `.github/` and `renovate.json` remain destination-owned;
- the copied Markdown is byte-identical to the approved source note;
- required CI and preview checks pass;
- both Vercel production deployments correspond to the Artur merge SHA;
- deployed smoke tests pass;
- the Artur tag points to the deployed Artur SHA;
- the GitHub Release matches the reviewed shareable copy;
- the manifest links both pull requests and both immutable SHAs.

## Rollout

The one-time pipeline implementation requires two technical pull requests:

1. Rework the existing `ai-workflow` release-pipeline pull request so it owns
   preparation, release-note approval, and cross-repository synchronization,
   but no direct Artur deployment.
2. Add the destination-owned validation, deployment observation, smoke test,
   tag, manifest, and GitHub Release workflow in `ai-workflow-arthur`.

Before enabling the first production release:

1. reconcile existing Artur-only application commits against current source;
2. configure the narrowly scoped GitHub App access;
3. confirm branch protection and required checks in both repositories;
4. confirm both Vercel projects deploy from `ai-workflow-arthur/main`;
5. select Zak's last-reviewed source commit;
6. run preparation and review the first release notes;
7. rehearse the full snapshot and preview in the second pull request;
8. merge the Artur pull request and verify production evidence.

## Success Criteria

For every Artur release, the team can provide:

- one reviewed, non-technical release-note file in both repositories;
- the exact source application SHA;
- the exact deployed Artur SHA;
- links to both reviewed pull requests;
- proof that the complete source snapshot was synchronized;
- links to dashboard and worker production deployments;
- smoke-test evidence;
- an immutable Artur tag, GitHub Release, and manifest.

No workflow in `ai-workflow` can deploy Artur production directly, and no
Artur production release can occur without merging the destination pull
request.
