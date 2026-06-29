# GitLab.com setup

This is a single-project GitLab.com setup guide for the token-based ai-workflow integration. Self-managed GitLab is not the scope of this guide.

## Required environment variables

Set these on the worker deployment:

```bash
VCS_KIND=gitlab
GITLAB_TOKEN=<project access token or bot PAT>
GITLAB_PROJECT_ID=<namespace/project path>
GITLAB_BASE_BRANCH=main
GITLAB_WEBHOOK_SECRET=<random secret>
```

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

## Find the project ID

Set `GITLAB_PROJECT_ID` to the GitLab project path in `namespace/project` form, for example:

```bash
GITLAB_PROJECT_ID=my-group/my-repo
```

Numeric GitLab project IDs work for some GitLab REST APIs, but they are not supported by this app. The worker also uses `GITLAB_PROJECT_ID` to build sandbox clone and push URLs, so it must be a namespace/project path. The app URL-encodes the path internally before calling the GitLab API.

## Configure the webhook

In the GitLab project, open **Project Settings -> Webhooks** and add:

- URL: `https://<worker-deployment>/webhooks/gitlab`
- Secret token: the same value as `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**
- SSL verification: enabled

Use GitLab's **Secret token** field for now, not the newer **Signing token**
flow. The worker currently verifies the `X-Gitlab-Token` header.

Redeploy the worker after setting or rotating `GITLAB_WEBHOOK_SECRET`.

## Smoke checklist

After deployment, verify:

- Opening or updating a `blazebot/<ticket>` merge request triggers the webhook.
- The webhook route dispatches the post-PR gate after the PR-ready gate.
- The merge request shows `blazebot / ...` commit statuses on the head commit.
- Force-pushing the branch cancels or replaces stale statuses for the previous head commit.
- Changed files are read from GitLab merge request diffs.

## Official references

- [Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [Project webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [Commits API](https://docs.gitlab.com/api/commits/)
