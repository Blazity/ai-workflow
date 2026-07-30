# Artur releases

Customer-readable release notes live in this directory as
`YYYY.MM.PATCH.md`. The corresponding immutable Git tag is
`artur-vYYYY.MM.PATCH`.

The Markdown file in this directory is the canonical, reviewable record. After
deployment, its customer-readable section is also published as a GitHub Release
that can be shared with everyone at Artur. Technical scope stays below the
shareable markers and is not copied into the GitHub Release.

## Release flow

1. Run **Actions → Prepare Artur Release**. For the first release, provide the
   commit Zak last reviewed as `previous_ref`. Later runs use the newest
   `artur-v*` tag automatically. Keep `dry_run` enabled to inspect artifacts
   without creating a branch.
2. Run it again with `dry_run` disabled to open a docs-only pull request.
3. Edit and approve the non-technical wording in
   `docs/releases/artur/YYYY.MM.PATCH.md`, submit an approving GitHub review,
   then merge that PR. A direct commit or an unapproved PR cannot be released.
4. Run **Actions → Release to Artur** with the same version. The workflow
   validates the immutable docs-only candidate, runs the full test suite, waits
   for approval on the `artur-production` environment, stages and smoke-tests
   both Vercel projects, promotes them, deploys the selected workflow
   definition, smoke-tests Artur's production URLs, and only then creates the
   tag and GitHub Release.

Create a GitHub environment named `artur-release-preparation`, restrict its
deployment branches to protected `main`, and store
`RELEASE_BOT_APP_ID` and `RELEASE_BOT_APP_PRIVATE_KEY`. AI drafting is optional:
when `ANTHROPIC_API_KEY` is unavailable or the response is invalid, the
generator produces a deterministic draft for human rewriting. Store
`ANTHROPIC_API_KEY` in the same environment when AI drafting is enabled. Do not
keep these release credentials as unrestricted repository secrets.

## Pull request metadata

Use exactly one of `release:feature`, `release:improvement`, `release:fix`,
`release:internal`, or `release:skip`. Complete the **User impact**,
**Required action**, and **Release note** sections. Missing metadata is reported
during preparation but does not block ordinary PR merges.

The generated release-note PR is docs-only. Reviewers own every
customer-facing statement. Preparation always starts from protected `main`;
arbitrary refs are not executed with release credentials. Merging the PR
approves copy but does not deploy.

## Protected environment setup

Create a GitHub environment named `artur-production`, require at least one
reviewer, add the people allowed to approve an Artur deployment, prevent
self-review where your GitHub plan supports it, restrict deployment branches
to protected `main`, and configure:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `VERCEL_TOKEN` | Scoped token used by the pinned Vercel CLI. |
| Secret | `ARTUR_SESSION_TOKEN` | Owner session used only for the workflow-definition GET/deploy calls. Refresh it before expiry. |
| Secret | `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional. Used only by production smoke checks when Artur domains are protected. |
| Variable | `VERCEL_ORG_ID` | Vercel team/account ID shared by both projects. |
| Variable | `ARTUR_WORKER_PROJECT_ID` | Existing worker Vercel project. |
| Variable | `ARTUR_DASHBOARD_PROJECT_ID` | Existing dashboard Vercel project. |
| Variable | `ARTUR_WORKER_BASE_URL` | Canonical production worker URL, without a trailing slash. |
| Variable | `ARTUR_DASHBOARD_BASE_URL` | Canonical production dashboard URL, without a trailing slash. |
| Variable | `ARTUR_WORKFLOW_DEFINITION_ID` | Numeric workflow definition to publish after app promotion. |

Both Vercel projects must already have their production environment variables
and integrations configured. In particular, the worker must point at the
intended production database and the dashboard must point at the canonical
worker URL. The pipeline selects projects with `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID`; it does not create or reconfigure Vercel projects.

## Records and sharing

Each release leaves four records:

- the reviewed canonical file in `docs/releases/artur/`;
- the immutable `artur-vYYYY.MM.PATCH` Git tag;
- a GitHub Release containing only the non-technical, shareable section;
- `release-manifest.json`, attached to the GitHub Release and retained with the
  Actions artifact, containing the exact commit, Vercel deployment URLs,
  workflow-definition version, migrations, test run, release-note reviewers,
  dispatcher, and the actual `artur-production` approver returned by GitHub's
  workflow approval history.

The preparation report and validation files are retained as workflow artifacts
under the corresponding Actions run. They are audit material, not customer
copy.

## Failure and recovery

A failed run does not create a Git tag or GitHub Release. Before promotion, the
canonical Artur domains are unchanged; inspect the staged deployment URLs in
the failed job and fix the cause.

If promotion succeeded but a later workflow-definition or production smoke
step failed, do not guess at a broad automated rollback. Inspect both Vercel
projects and the release artifact, then roll back only the affected project
with `vercel rollback <previous-deployment-url>` while using that project's
`VERCEL_PROJECT_ID`. Record the recovery in the release PR or incident notes.

If only GitHub Release publication failed after every production check passed,
use the retained `shareable.md` and `release-manifest.json` artifacts to publish
the exact approved candidate; do not regenerate the wording from a newer
`main`.
