# Artur Release Notes Pipeline Design

**Date:** 2026-07-30  
**Status:** Approved design, pending implementation plan

## Goal

Build a repeatable release process that:

1. determines exactly which changes are included in an Artur deployment;
2. produces release notes understandable to non-technical Artur employees;
3. requires human review before publishing customer-facing claims;
4. deploys and tests one exact Git commit;
5. records what was deployed in an auditable release manifest.

The first release must also cover the changes made since Zak's last product
review, even though the repository does not yet have a regular Artur tag
history.

## Decisions

- A successful deployment to the protected `artur-production` environment is
  the source of truth that a release happened.
- GitHub Actions hosts the release automation.
- A checked-in Markdown file is the source of truth for the release-note copy.
- Customer-facing release notes are written in English.
- AI creates a draft from pull request metadata; it does not publish directly.
- A human reviews the release-note pull request before deployment.
- The tag and GitHub Release are created only after deployment and smoke tests
  succeed.
- The initial implementation is repository automation. Product integration is
  outside this scope.

## Non-goals

- Automatically publishing a release after every merge.
- Generating customer claims from source-code diffs alone.
- Replacing engineering changelogs, commit history, or deployment logs.
- Supporting multiple customer-specific pipelines in the first increment.
- Adding a release-management interface to the dashboard.
- Sending the published notes to email or Slack automatically.

## Considered Approaches

### 1. Pull request metadata plus AI rewriting and human review

Each pull request supplies a small amount of user-impact metadata. The release
workflow collects merged pull requests, filters and classifies them, and asks
an AI model to rewrite supported facts in non-technical language. A person
reviews the generated Markdown in a pull request.

This is the selected approach. It combines reliable source facts with low
authoring overhead and keeps a human responsible for external communication.

### 2. AI-generated notes from commit messages and diffs

This has the lowest process overhead, but commit messages and diffs often do
not contain enough product context. It also requires sending more repository
content to an external model and makes unsupported claims harder to detect.

### 3. Manually maintained changelog fragments

This is deterministic and model-independent, but it creates more work in every
pull request. Missing fragments would become common unless the repository
blocked merges, which is too strict for the initial release process.

## Repository Layout

The implementation will use these locations:

```text
.github/
├── PULL_REQUEST_TEMPLATE.md
└── workflows/
    ├── prepare-artur-release.yml
    └── release-artur.yml

scripts/release-notes/
├── collect.ts
├── classify.ts
├── generate.ts
├── render.ts
├── types.ts
└── *.test.ts

docs/releases/artur/
├── README.md
└── <version>.md
```

Responsibilities:

- `collect.ts` obtains the merged pull requests between two Git references and
  normalizes their metadata.
- `classify.ts` applies release labels, exclusions, and missing-metadata
  warnings without using AI.
- `generate.ts` produces structured customer-facing copy from the normalized
  facts.
- `render.ts` validates and writes the canonical Markdown format.
- `types.ts` owns the interfaces shared by collection, generation, rendering,
  and tests.
- `prepare-artur-release.yml` generates a release-notes pull request.
- `release-artur.yml` verifies, deploys, smoke-tests, tags, and publishes the
  approved release.
- `docs/releases/artur/<version>.md` is the checked-in source of truth for the
  shareable release notes.

## Pull Request Metadata Contract

The pull request template will add:

```markdown
## User impact

What can a user do now, or what works better for them?

## Required action

Does a user or administrator need to do anything after release?

## Release note

One non-technical sentence, or `internal`.
```

The repository will use the following mutually exclusive release
classification labels:

- `release:feature`
- `release:improvement`
- `release:fix`
- `release:internal`
- `release:skip`

The first implementation reports missing metadata in the preparation output
but does not block ordinary pull request merges. It does block release
publication when an included customer-facing pull request cannot be traced to
an approved release-note bullet.

`release:internal` remains in the technical scope but is excluded from
customer-facing sections. `release:skip` is excluded from the release-notes
input and listed in the preparation report so the omission remains visible.

## Release Note Format

The canonical file is:

```text
docs/releases/artur/<version>.md
```

Versions use calendar version numbers in `YYYY.MM.PATCH` form without a leading
`v` in filenames, for example `docs/releases/artur/2026.08.0.md`. The
corresponding Git tag is `artur-v2026.08.0`.

Every file contains:

```markdown
---
version: 2026.08.0
previousCommit: full-base-sha
targetCommit: full-target-sha
---

# AI Workflow — 2026.08.0

## Highlights

One short paragraph explaining the overall value of the release.

## What's new

- Customer-facing capabilities.

## Improvements and fixes

- User-visible reliability and usability improvements.

## Do you need to do anything?

Explicit actions, or a statement that no action is required.

## Known limitations

Only limitations relevant to Artur users. If there are none, say so.

## Exact release scope

- Technical pull request links and classifications.
```

The first five sections are shareable. The exact-scope section is retained for
review and audit. The renderer uses explicit shareable-section markers so a
GitHub Release body can be produced without duplicating or manually copying
the text.

## Preparation Workflow

An authorized team member starts the workflow at:

```text
GitHub repository → Actions → Prepare Artur Release → Run workflow
```

`prepare-artur-release.yml` accepts:

- `version`: required calendar version in `YYYY.MM.PATCH` form, such as
  `2026.08.0`;
- `previous_ref`: optional after the first release; defaults to the newest
  `artur-v*` tag;
- `dry_run`: optional boolean that generates artifacts without creating a
  branch or pull request.

The workflow:

1. checks out trusted protected `main` and resolves `previous_ref` and `main`
   to full immutable commit SHAs;
2. rejects an existing version, tag, or release-notes file;
3. collects pull requests merged within the Git comparison;
4. classifies included, internal, and skipped changes;
5. reports missing user-impact metadata;
6. generates structured English release-note copy from pull request metadata;
7. validates that every generated bullet references at least one source pull
   request;
8. renders `docs/releases/artur/<version>.md`;
9. creates `release/artur-<version>` from the resolved protected `main` SHA;
10. opens a pull request containing the notes and a preparation report.

The AI input contains pull request numbers, titles, bodies, labels, and the
three release fields. It does not contain source-code diffs, repository
secrets, comments unrelated to the release fields, or customer code.

The preparation pull request description lists:

- resolved base and target SHAs;
- customer-facing pull requests;
- internal pull requests;
- deliberately skipped pull requests;
- missing metadata warnings;
- the workflow run URL.

The person reviewing the pull request owns the wording and may edit the
Markdown normally. Merging the pull request approves the release-note copy but
does not deploy anything. If unrelated product changes enter the release-note
pull request before it is merged, the preparation workflow must be rerun so
those changes are either documented or excluded from the release candidate.

## Deployment and Publication Workflow

An authorized team member starts:

```text
GitHub repository → Actions → Release to Artur → Run workflow
```

`release-artur.yml` accepts only `version`. It finds the merged pull request
that added the release-note file and uses that pull request's merge commit as
the immutable release candidate. It derives the intended product range from
the full `previousCommit` and `targetCommit` SHAs stored in the file.

The workflow:

1. loads `docs/releases/artur/<version>.md`;
2. validates its schema, version, and source references;
3. resolves the exact merge commit that introduced the approved file;
4. verifies that the candidate came from one merged, approved, docs-only pull
   request; that its Markdown is byte-identical to the reviewed candidate; and
   that `previousCommit → targetCommit → candidate` is a valid ancestry chain;
5. recollects and classifies the exact Git range and requires the canonical
   scope to match it exactly;
6. runs type checking, unit tests, and the release-specific workflow/CLI gate
   on the candidate;
7. deploys the exact candidate to the non-production E2E Vercel project and
   runs the orchestration E2E against that deployment;
8. pauses at the protected GitHub environment `artur-production`;
9. requires an authorized reviewer to approve the environment deployment;
10. deploys the worker and dashboard from the exact candidate commit;
11. publishes the approved workflow definition or bundle for Artur;
12. runs the deployed smoke test;
13. creates `artur-v<version>` at the exact deployed candidate commit;
14. creates the GitHub Release from the shareable Markdown sections;
15. attaches `release-manifest.json`;
16. writes links to the deployments, tag, release, tests, and manifest into the
    GitHub Actions job summary.

Steps 13–16 run only when deployment and the smoke test succeed. A failed
release attempt therefore produces neither a tag nor a published GitHub
Release.

The workflow must be concurrency-locked to one Artur production release at a
time.

## Release Manifest

`release-manifest.json` is generated after the smoke test and attached to the
GitHub Release. It is not committed after deployment because that would
create a Git commit different from the one deployed.

The manifest records:

```json
{
  "version": "2026.08.0",
  "releasedAt": "2026-08-03T10:00:00Z",
  "commit": "full-git-sha",
  "environment": "artur-production",
  "dashboardDeployment": {
    "id": "deployment-id",
    "url": "https://deployment.example"
  },
  "workerDeployment": {
    "id": "deployment-id",
    "url": "https://deployment.example"
  },
  "workflowDefinitionVersion": "immutable-workflow-version",
  "databaseMigrations": ["migration identifiers applied by this release"],
  "testRun": "https://github.com/org/repo/actions/runs/id",
  "initiatedBy": "github-login",
  "productionApprovedBy": ["github-login"],
  "releaseNotesReview": {
    "pullRequest": 123,
    "approvedBy": ["github-login"]
  }
}
```

The concrete deployment and workflow identifiers will be populated from the
existing deployment commands selected during implementation. No identifier
may be supplied manually when it can be read from deployment output.

## First Artur Release

There is no reliable previous Artur release tag. The first preparation run
therefore requires an explicitly reviewed `previous_ref` representing the code
Zak last reviewed. The workflow resolves and records that reference as a full
SHA.

The initial draft is expected to investigate these user-facing groups, but it
may include them only when supported by pull requests in the selected range:

- GitHub and GitLab support;
- multiple repositories and cross-repository dependencies;
- multiple pull requests or merge requests from one run;
- editable and versioned workflows;
- manual workflow dispatch;
- agent execution profiles;
- clearer run state, errors, and replay information;
- improved review-and-fix handling;
- repository context and routing memory.

After the first successful release, the newest `artur-v*` tag becomes the
default base automatically.

## AI Generation Rules

The generator returns a validated structured object rather than free-form
Markdown. Each item contains:

- target section;
- customer-facing text;
- source pull request numbers;
- whether user action is required.

Generation rules:

- use non-technical English;
- describe observable user value, not implementation details;
- do not invent availability, performance, security, or compatibility claims;
- do not mention internal ticket keys in shareable sections;
- combine duplicate changes only when all source pull requests remain linked;
- keep known limitations explicit;
- return an error for an unsupported claim rather than guessing.

The renderer, not the model, owns headings, ordering, link syntax, and
shareable-section markers.

## Failure Handling

- Invalid or reused version: stop before generation.
- Missing previous tag after the first release: stop and require an explicit
  `previous_ref`.
- Empty comparison range: stop; do not create an empty release.
- GitHub API failure: stop and preserve the workflow logs.
- Missing metadata: create a preparation report warning; publication remains
  blocked until included bullets are traceable.
- AI service failure or invalid output: render a deterministic draft from the
  normalized release-note fields and label it as requiring human rewrite.
- Release-note validation failure: stop before tests or deployment.
- Test failure: stop before environment approval.
- Deployment failure: do not create a tag or GitHub Release.
- Smoke-test failure: do not create a tag or GitHub Release; retain deployment
  logs for diagnosis.
- Existing tag or GitHub Release during publication: stop without overwriting
  it.

Rerunning preparation is safe until its pull request is merged. Rerunning
publication for an already published version is rejected rather than mutating
an immutable release.

## Security and Permissions

- Workflows use least-privilege `GITHUB_TOKEN` permissions.
- The preparation workflow runs only from protected `main` in the
  `artur-release-preparation` environment and uses a read-only `GITHUB_TOKEN`.
- Its GitHub App credentials and optional AI key are environment-scoped; the
  App token is minted only for the branch/pull-request publication steps.
- If GitHub's workflow token cannot trigger the repository's required checks,
  the preparation workflow uses a dedicated GitHub App installation token
  rather than a personal access token.
- Deployment secrets are scoped to the protected `artur-production`
  environment and unavailable before approval.
- The AI credential is stored as an Actions or protected preparation
  environment secret.
- Secrets and full diffs are never included in the AI prompt, artifacts,
  release notes, or manifest.
- Release publication uses an exact resolved SHA, not a mutable branch name.
- Publication rejects a release-note merge commit containing changes other
  than the approved release-note file on top of its recorded `targetCommit`.

## Testing Strategy

### Unit tests

Fixture-based tests cover:

- Git comparison and pull request normalization;
- label precedence and internal/skip filtering;
- extraction of the three pull request fields;
- missing metadata reporting;
- structured AI output validation;
- deterministic fallback generation;
- Markdown rendering and shareable-section extraction;
- version and tag validation;
- traceability from every customer bullet to source pull requests.

### Workflow tests

- Run preparation in `dry_run` mode against a small known commit range.
- Confirm the generated Markdown and preparation report are uploaded as
  artifacts and no branch is created.
- Run preparation against the proposed first Artur range and review the
  included, internal, and skipped sets.
- Exercise publication against a non-production test environment using a
  disposable version and confirm failure before tagging when a smoke test is
  forced to fail.
- Complete one release rehearsal that deploys the exact candidate SHA but
  suppresses tag and GitHub Release creation.

### Release acceptance

A production release is accepted only when:

- the release-note pull request has an approved review and is merged;
- the release candidate differs from its recorded `targetCommit` only by the
  approved release-note file;
- unit, type, release-specific, workflow-contract, and non-production
  orchestration E2E checks pass;
- the protected environment deployment is approved;
- worker, dashboard, and workflow versions are captured;
- the deployed smoke test passes;
- the tag points to the deployed SHA;
- the GitHub Release matches the checked-in shareable copy;
- the attached manifest contains the exact deployment evidence.

## Rollout

1. Add the pull request metadata contract, labels documentation, release-note
   schema, and unit-test fixtures.
2. Implement deterministic collection, classification, rendering, and
   validation.
3. Add structured AI generation with deterministic fallback.
4. Add and dry-run the preparation workflow.
5. Configure the protected `artur-production` GitHub environment.
6. Add deployment, smoke-test, manifest, tag, and GitHub Release publication.
7. Rehearse the complete flow without publishing.
8. Select Zak's last-reviewed commit and generate the first Artur release
   notes.
9. Review, deploy, and publish the first version.

## Success Criteria

For every Artur release, the team can provide:

- a customer-readable English summary;
- a stable link to the GitHub Release;
- the canonical Markdown file in the repository;
- the exact deployed Git SHA;
- exact worker, dashboard, and workflow versions;
- the deployment approval and test-run evidence;
- a complete list of included, internal, and skipped pull requests.

No customer-facing release can be published before human review, production
approval, successful deployment, and a deployed smoke test.
