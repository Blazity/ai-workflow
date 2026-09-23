Status: current
Last-verified: 2026-09-23

# GitLab.com setup

This is a GitLab.com setup guide for the token-based ai-workflow integration. Self-managed GitLab is not the scope of this guide.

## Where the values go

GitLab is an integration, so an admin can enter every value below in the dashboard under **Integrations → GitLab → Connection**, and the source switches from the environment to the stored connection. Until they do, the environment is the source and the variable names are the ones in this guide.

There is no variable that selects GitLab as "the" provider: a repository carries its own provider, so a deployment can run GitHub, GitLab or both.

## Required values

Set these on the worker deployment, or enter them on the Integrations page:

```bash
GITLAB_TOKEN=<project access token or bot PAT>
GITLAB_WEBHOOK_SECRET=<random secret>
```

Optional:

```bash
GITLAB_HOST=<self-managed base URL, defaults to https://gitlab.com>
GITLAB_PROJECT_ID=<legacy single-project filter; leave unset on a new deployment>
```

Required when an enabled `trigger_pr_review` includes `commented`:

```bash
GITLAB_BOT_LOGIN=<token account username>
```

`GITLAB_BOT_LOGIN` prevents review notes authored by the automation account from recursively triggering `trigger_pr_review`. The legacy `VCS_BOT_LOGIN` value is accepted only when GitLab is the sole configured VCS provider. A mixed GitHub/GitLab deployment requires `GITHUB_BOT_LOGIN` and `GITLAB_BOT_LOGIN` for the providers selected by a commented-review trigger.

`GITLAB_PROJECT_ID` is no longer required for multi-repo runs. When it is omitted, ai-workflow lists all projects visible to `GITLAB_TOKEN` and accepts GitLab merge request webhooks after token verification. When it is set, the webhook ignores merge requests from every other project with reason `other_project`, even projects enabled on the Repositories page (`integrations/gitlab/webhook.ts`), so leave it unset on a new deployment.

The Repositories import records GitLab's default branch in the repository
profile. Leave it unset to use the provider default, or edit the profile to
override it.

You can configure GitHub and GitLab in the same deployment. Provider credentials are additive.

Redeploy the worker after changing environment variables. A value entered on the Integrations page takes effect without a redeploy.

## Create the token

Prefer a Project Access Token when your GitLab.com plan and project settings allow one. If a Project Access Token is unavailable, use a dedicated bot or service-account Personal Access Token.

Do not use a human day-to-day token for production automation.

Grant the token both required scopes:

- `api` for GitLab REST API writes: branches, merge requests, comments/discussions, commit statuses, and project metadata.
- `write_repository` for Git-over-HTTPS clone and push from the trusted publisher.

`write_repository` alone is not enough because ai-workflow still needs REST API calls authenticated with `api`.

Save the token as `GITLAB_TOKEN`.

## Configure permissions

The token identity must have enough project access to create branches, open merge requests, push commits, and create commit statuses.

Use the Maintainer role for the simplest setup. Developer can work only if the project's branch protection rules allow that identity to push and force-push `ai-workflow/*` branches and open merge requests. Keep the same permission for legacy `blazebot/*` branches while historical workflow-owned branches remain active.

Prefer leaving `ai-workflow/*` branches unprotected. If you protect that branch pattern, make sure the token identity is allowed to push and allowed to force-push it. Apply equivalent rules to legacy `blazebot/*` branches until those historical workflow-owned branches are retired.

The agent workspace never receives `GITLAB_TOKEN` or other push credentials.
After the agent exits, the worker creates a separate short-lived trusted
publisher sandbox, validates every target, and pushes the exact prepared commit
with:

```bash
git push origin <target>:refs/heads/<branch> \
  --force-with-lease=refs/heads/<branch>:<expected-remote-sha>
```

The exact lease rejects remote branch drift instead of overwriting work that
appeared after preparation. Existing workflow-owned `blazebot/*` branches use
the same publisher and lease contract.

## Optional: set a legacy project ID

Only an older deployment that already relies on one project needs this. Set `GITLAB_PROJECT_ID` to that project, for example:

```bash
GITLAB_PROJECT_ID=my-group/my-repo
```

The value may be the numeric project id or the `namespace/project` path; the webhook compares it with either. Clone and push URLs come from the repository catalog, not from this value.

## Configure the webhook

This section is the one list of the GitLab webhook settings; SETUP.md links here. GitLab has no health check for the webhook's event selection, so a missing event is silent.

In the GitLab project, open **Project Settings -> Webhooks** and add:

- URL: `https://<worker-deployment>/webhooks/gitlab`
- Secret token: the same value as `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**, **Pipeline events**, and **Comments**
- SSL verification: enabled

**Merge request events** deliver the **Merge Request Hook**, which drives `trigger_pr_created`, `trigger_pr_updated`, `trigger_pr_ready` and `trigger_pr_merged`. **Pipeline events** deliver the **Pipeline Hook**, which drives `trigger_pr_checks_failed`. That trigger requires at least one exact check name and defaults to the trusted `merge_request_event` pipeline source. A Pipeline Hook carries no merge request head commit, so before dispatch the worker reads the merge request's current head pipeline and dispatches only when a failed check the event names is still failed there. Without Pipeline events, the trigger never fires.

**Comments** deliver the **Note Hook** used by `trigger_pr_review`. The worker maps an eligible, external, non-system merge request note only to `commented`; internal and confidential notes are dropped by the normalizer (`integrations/gitlab/webhook.ts`). It does not infer reviewer state from the author's current reviewer record. GitLab does not emit a reliable event that distinguishes a new Request Changes transition, with or without a summary, so GitLab `changes_requested` triggers are unsupported until such an event exists. Any review-trigger configuration that includes GitLab must include `commented`, and every review trigger must retain at least one selected state.

For webhook redelivery, the worker uses `webhook-id`, then `Idempotency-Key`. If neither header is present, it hashes `X-Gitlab-Event-UUID`, a NUL separator, and the raw request body. `X-Gitlab-Webhook-UUID` identifies the webhook configuration and is deliberately not used as a delivery ID.

Use GitLab's **Secret token** field for now, not the newer **Signing token**
flow. The worker currently verifies the `X-Gitlab-Token` header.

Without `GITLAB_WEBHOOK_SECRET` every delivery is refused with 503. Redeploy the worker after setting or rotating it in the environment.

## Smoke checklist

After deployment, verify:

- Opening or updating an `ai-workflow/<ticket>` merge request triggers the webhook. Existing `blazebot/<ticket>` merge requests remain recognized.
- The webhook route dispatches the merge request workflow triggers (`trigger_pr_created`, `trigger_pr_updated`, `trigger_pr_ready`, `trigger_pr_merged`) for eligible merge request events.
- New merge requests show `AI Workflow / ...` commit statuses on the head commit. Existing `blazebot / ...` statuses remain recognized and updated through their stored references.
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
