# AIW-32 GitLab.com parity design

**Date:** 2026-06-29
**Status:** Approved design
**Branch/worktree:** `codex/aiw-32-gitlab-parity` at `.worktrees/aiw-32-gitlab-parity`

## Goal

Complete GitLab.com support for the same single-project product workflow that
GitHub supports today.

The existing GitLab adapter already covers the main agent workflow surface:
branch creation/reset, merge request creation, sandbox push, MR lookup, MR
comments/discussions, pipeline/job status, failed job logs, conflict status, and
branch SHA lookup. AIW-32 should close the remaining parity gap around the
post-PR gate path and setup documentation.

## Non-goals

- No self-hosted GitLab support.
- No GitLab OAuth/application install flow.
- No group-level or multi-repo selection.
- No GitLab API surface unrelated to the current app workflow.
- No deep change to the main agent workflow unless required for parity.

## Chosen Approach

Use a provider-neutral gate status abstraction.

The post-PR gate should remain one workflow. GitHub and GitLab webhooks should
normalize their provider payloads into the same `PostPrGateWorkflowInput`. The
workflow should then create visible gate statuses, run the configured gate
steps, and update the statuses through a VCS capability interface.

Provider-specific behavior stays at the edges:

- GitHub route: parse `pull_request` webhooks and continue using GitHub Check
  Runs.
- GitLab route: parse merge request webhooks and use GitLab commit statuses on
  the MR source-branch head SHA.
- GitHub adapter: continue using PR file APIs for file listing.
- GitLab adapter: add MR file listing through GitLab merge request diff/change
  APIs.

This avoids duplicating the post-PR gate workflow while keeping GitLab behavior
GitLab-native.

## Auth And Config

GitLab auth stays token-based for AIW-32:

- Runtime env remains `GITLAB_TOKEN` plus `GITLAB_PROJECT_ID`.
- Recommend a GitLab Project Access Token when available.
- Document a dedicated bot/service-account Personal Access Token as the
  fallback for GitLab.com Free-tier projects or organizations that cannot use
  project access tokens.
- Do not add OAuth/app installation, callback handling, token storage, or token
  refresh in this ticket.

Config changes:

- Keep `GITLAB_HOST` defaulted to `https://gitlab.com`.
- Add `GITLAB_WEBHOOK_SECRET`.
- Require `GITHUB_WEBHOOK_SECRET` only when `VCS_KIND=github`.
- Require `GITLAB_WEBHOOK_SECRET` only when `VCS_KIND=gitlab` and the GitLab
  webhook route is enabled by configuration.

## Data Flow

1. GitHub `/webhooks/github` receives `pull_request` events.
2. GitLab `/webhooks/gitlab` receives merge request events.
3. Both routes produce `PostPrGateWorkflowInput`:
   PR/MR number, head SHA, source branch, target branch, title, body, author,
   draft/WIP flag, URL, and repo key.
4. `postPrGateWorkflow` applies the existing run filters: bot branch, draft/WIP,
   and base branch.
5. The workflow fetches Jira context from the ticket key embedded in the branch
   name.
6. The workflow creates one visible gate status per configured gate step.
7. The gate runner executes the configured steps and updates each status with
   success, failure, neutral, skipped, or cancelled.
8. Code hygiene continues to call `listPRFiles`; GitLab implements the same
   capability with MR diffs/changes.

Status naming should stay consistent across providers, for example
`blazebot / pr-title-format` and `blazebot / code-hygiene`.

GitLab does not have a direct GitHub Check Run equivalent. It should use commit
statuses as the visible MR UI signal. GitHub-style inline check annotations stay
GitHub-only unless GitLab support is added through a native API in a later
ticket.

## Error Handling

- Reject GitLab webhook requests with missing or invalid `X-Gitlab-Token` as
  `401`.
- Ignore non-merge-request GitLab events.
- Ignore merge request actions outside opened, updated, or reopened-equivalent
  events.
- Ignore GitLab webhooks for projects other than the configured
  `GITLAB_PROJECT_ID`.
- Reuse the existing `GateStore` lock, dedupe, and cancellation behavior, keyed
  by GitLab project identity plus MR IID.
- Treat visible gate status creation/update as mandatory, matching GitHub
  behavior. If status creation/update fails, fail the post-PR gate.
- If a provider cannot return file patches for a file, let code hygiene handle
  it as unavailable patch data rather than creating a GitLab-specific failure
  path.

## Testing

Unit coverage:

- GitLab adapter gate-status creation/update mapping to commit statuses.
- GitLab adapter MR file listing and file status mapping.
- GitLab webhook secret validation.
- GitLab webhook payload mapping into `PostPrGateWorkflowInput`.
- Env validation for provider-specific webhook secrets.
- Existing post-PR gate runner tests after the capability rename/generalization.

Verification:

- Run targeted GitLab adapter and webhook tests first.
- Run `pnpm --filter worker typecheck`.
- Run `pnpm --filter worker test`.
- Document a manual GitLab.com smoke because real webhook delivery and MR status
  rendering require a configured GitLab.com project.

## Setup Documentation

Add `docs/GITLAB-SETUP.md` covering:

- Choosing Project Access Token versus dedicated bot PAT.
- Required scopes/permissions for API writes and Git-over-HTTPS push.
- `GITLAB_PROJECT_ID` format, including numeric project ID and URL-encoded
  namespace/project path guidance if needed.
- Webhook URL: `https://<deployment>/webhooks/gitlab`.
- Merge request webhook event subscription.
- Secret token setup and `GITLAB_WEBHOOK_SECRET`.
- Required env vars:
  - `VCS_KIND=gitlab`
  - `GITLAB_TOKEN`
  - `GITLAB_PROJECT_ID`
  - `GITLAB_BASE_BRANCH`
  - `GITLAB_WEBHOOK_SECRET`
  - existing non-VCS env vars needed by the worker.
- Redeploy step after changing env vars.

Official docs used for the implementation plan:

- GitLab Merge Requests API: https://docs.gitlab.com/api/merge_requests/
- GitLab Commits API: https://docs.gitlab.com/api/commits/
- GitLab project webhooks: https://docs.gitlab.com/user/project/integrations/webhooks/
- GitLab project access tokens: https://docs.gitlab.com/user/project/settings/project_access_tokens/
- GitLab personal access tokens: https://docs.gitlab.com/user/profile/personal_access_tokens/
