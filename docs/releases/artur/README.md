# Artur releases

Customer-readable release notes live here as `YYYY.MM.PATCH.md`. The same
reviewed file is copied into `Blazity/ai-workflow-arthur` by the release
pipeline. The Artur repository publishes tag `artur-vYYYY.MM.PATCH` only after
its Vercel production deployment and smoke tests succeed.

## Two-pull-request release flow

1. In `Blazity/ai-workflow`, run **Actions → Prepare Artur Release**. Supply
   the source commit Zak last reviewed as `previous_ref` for the first release.
   Keep `dry_run` enabled to inspect the draft without opening a pull request.
2. Run preparation with `dry_run` disabled. Review the docs-only pull request,
   edit the non-technical English wording where needed, and approve it. Before
   merging, run the tenant-database check in
   [`upgrade-preflight.md`](upgrade-preflight.md). Merge only after the check
   identifies no unrepaired deployed workflows.
3. The merge automatically runs **Sync Approved Artur Release**. It copies the
   complete application tree from the pinned `targetSourceCommit` into a new
   `release/artur-<version>` branch in `Blazity/ai-workflow-arthur`.
4. Review the second pull request in the Artur repository. Its CI independently
   verifies the complete source snapshot; the Vercel Git integration provides
   preview deployments.
5. Merge the Artur pull request to approve production. Vercel deploys the
   worker and dashboard from `ai-workflow-arthur/main`. The Artur-owned
   publication workflow waits for both deployments, smoke-tests production,
   then creates the tag, GitHub Release, and `release-manifest.json`.

The source repository never deploys Artur production directly.

The pre-merge check names deployed workflows whose Loop carries a frozen copy
of a schema the release has since changed, which would otherwise break a
working configuration the tenant never touched.

## Ownership and synchronization

The synchronization replaces every tracked application path, including
`apps/*/vercel.json`, and removes obsolete source-owned files. Only these Artur
repository paths remain destination-owned:

- `.github/`
- `renovate.json`

An Artur-only application hotfix must be backported to `ai-workflow` before the
next release. A patch that is not present in the selected source range blocks
the synchronization workflow instead of being silently overwritten.

Before the first release, review the existing Artur-only commits and set
`ARTUR_INITIAL_BASE_SHA` to the reviewed Artur `main` commit. Later releases
use the source SHA recorded in the latest published `artur-v*` GitHub Release
automatically.

## Source repository configuration

Create an `artur-release-preparation` GitHub environment restricted to
protected `main` and configure:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `RELEASE_BOT_APP_ID` | GitHub App used to open both release pull requests. |
| Secret | `RELEASE_BOT_APP_PRIVATE_KEY` | Private key for the release App. |
| Secret | `ANTHROPIC_API_KEY` | Optional AI drafting; deterministic drafting is used when absent. |
| Variable | `RELEASE_NOTES_MODEL` | Optional model override. |
| Variable | `ARTUR_INITIAL_BASE_SHA` | One-time reviewed Artur baseline before the first tag exists. |

Install the App only on `ai-workflow` and `ai-workflow-arthur`, with repository
contents and pull-request write access. Preparation and PR creation mint
separate short-lived tokens, each scoped to one named repository and the
minimum permissions needed by that step.

## Pull-request metadata

Use exactly one of `release:feature`, `release:improvement`, `release:fix`,
`release:internal`, or `release:skip`. Complete **User impact**, **Required
action**, and **Release note** in product pull requests. Every customer-facing
bullet must cite an included pull request.

The release-note pull request is docs-only. `targetSourceCommit` freezes the
application snapshot, so product commits merged while the wording is reviewed
are not silently included.

## Records and recovery

Every completed release records:

- the identical reviewed Markdown in both repositories;
- the source application SHA and deployed Artur SHA;
- links to both pull requests;
- both Vercel status URLs and production URLs;
- the smoke-test Actions run;
- an Artur tag, GitHub Release, and attached manifest.

A failed synchronization leaves no Artur pull request. Failed Artur CI blocks
merge. Failed production deployment or smoke testing creates no tag or GitHub
Release. After correcting an external deployment issue, rerun the failed Artur
publication job for the same immutable merge commit; do not regenerate notes
from a newer source branch.
