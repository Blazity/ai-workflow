# GitLab.com setup

This is a GitLab.com setup guide for the token-based ai-workflow integration. Self-managed GitLab is not the scope of this guide.

## Required environment variables

Set these on the worker deployment:

```bash
GITLAB_TOKEN=<project access token or bot PAT>
GITLAB_WEBHOOK_SECRET=<random secret>
```

Optional legacy single-repo defaults:

```bash
GITLAB_PROJECT_ID=<namespace/project path>
GITLAB_BASE_BRANCH=main
VCS_KIND=gitlab
```

Required when an enabled `trigger_pr_review` includes `commented`:

```bash
GITLAB_BOT_LOGIN=<token account username>
```

`GITLAB_BOT_LOGIN` prevents review notes authored by the automation account from recursively triggering `trigger_pr_review`. The legacy `VCS_BOT_LOGIN` value is accepted only when GitLab is the sole configured VCS provider. A mixed GitHub/GitLab deployment requires `GITHUB_BOT_LOGIN` and `GITLAB_BOT_LOGIN` for the providers selected by a commented-review trigger.

`GITLAB_PROJECT_ID` is no longer required for multi-repo runs. When it is omitted, ai-workflow lists all projects visible to `GITLAB_TOKEN` and accepts GitLab merge request webhooks after token verification. When it is set, the webhook route keeps the old single-project filter.

You can configure GitHub and GitLab in the same deployment. Provider credentials are additive.

Redeploy the worker after changing environment variables.

## Create the token

Prefer a Project Access Token when your GitLab.com plan and project settings allow one. If a Project Access Token is unavailable, use a dedicated bot or service-account Personal Access Token.

Do not use a human day-to-day token for production automation.

Grant the token both required scopes:

- `api` for GitLab REST API writes: branches, merge requests, comments/discussions, commit statuses, and project metadata.
- `write_repository` for Git-over-HTTPS clone and push from the sandbox.

`write_repository` alone is not enough because ai-workflow still needs REST API calls authenticated with `api`.

Save the token as `GITLAB_TOKEN`.

## Configure permissions

The token identity must have enough project access to create branches, open merge requests, push commits, and create commit statuses.

Use the Maintainer role for the simplest setup. Developer can work only if the project's branch protection rules allow that identity to push and force-push `blazebot/*` branches and open merge requests.

Prefer leaving `blazebot/*` branches unprotected. If you protect that branch pattern, make sure the token identity is allowed to push and allowed to force-push `blazebot/*`. The worker always updates bot branches with `git push --force` from the sandbox after each run.

## Optional: set a legacy project ID

Set `GITLAB_PROJECT_ID` to the GitLab project path in `namespace/project` form, for example:

```bash
GITLAB_PROJECT_ID=my-group/my-repo
```

Numeric GitLab project IDs work for some GitLab REST APIs, but they are not supported for this legacy default because sandbox clone and push URLs need a namespace/project path. The app URL-encodes the path internally before calling the GitLab API.

## Configure the webhook

In the GitLab project, open **Project Settings -> Webhooks** and add:

- URL: `https://<worker-deployment>/webhooks/gitlab`
- Secret token: the same value as `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**, **Pipeline events**, and **Comments**
- SSL verification: enabled

**Merge request events** deliver the **Merge Request Hook**, which drives PR/MR creation and reuse. **Pipeline events** deliver the **Pipeline Hook**, which drives `trigger_pr_checks_failed`. That trigger requires at least one exact check name and defaults to the trusted `merge_request_event` pipeline source. Before dispatch, the worker verifies both `merge_request.last_commit.id` and the event pipeline ID against the merge request's current head and head pipeline. Without Pipeline events, the trigger never fires.

**Comments** deliver the **Note Hook** used by `trigger_pr_review`. The worker maps an eligible, external, non-system merge request note only to `commented`; internal/confidential notes are rejected at both the webhook route and normalizer. It does not infer reviewer state from the author's current reviewer record. GitLab does not emit a reliable event that distinguishes a new Request Changes transition, with or without a summary, so GitLab `changes_requested` triggers are unsupported until such an event exists. Any review-trigger configuration that includes GitLab must include `commented`, and every review trigger must retain at least one selected state.

For webhook redelivery, the worker uses `webhook-id`, then `Idempotency-Key`. If neither header is present, it hashes `X-Gitlab-Event-UUID`, a NUL separator, and the raw request body. `X-Gitlab-Webhook-UUID` identifies the webhook configuration and is deliberately not used as a delivery ID.

Use GitLab's **Secret token** field for now, not the newer **Signing token**
flow. The worker currently verifies the `X-Gitlab-Token` header.

Redeploy the worker after setting or rotating `GITLAB_WEBHOOK_SECRET`.

## Smoke checklist

After deployment, verify:

- Opening or updating a `blazebot/<ticket>` merge request triggers the webhook.
- The webhook route dispatches the post-PR gate for eligible merge request events.
- The merge request shows `blazebot / ...` commit statuses on the head commit.
- Force-pushing the branch cancels or replaces stale statuses for the previous head commit.
- Changed files are read from GitLab merge request diffs.
- A merge request comment dispatches `trigger_pr_review` when that event is enabled.
- Request Changes, with or without a summary, does not dispatch a GitLab `changes_requested` review trigger.

## Official references

- [Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [Project webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [Commits API](https://docs.gitlab.com/api/commits/)
