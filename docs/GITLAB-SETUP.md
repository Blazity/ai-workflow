# GitLab.com setup

This is a single-project GitLab.com setup guide for the token-based ai-workflow integration. Self-managed GitLab is not the scope of this guide.

## Required environment variables

Set these on the worker deployment:

```bash
VCS_KIND=gitlab
GITLAB_TOKEN=<project access token or bot PAT>
GITLAB_PROJECT_ID=<numeric project id or namespace/project path>
GITLAB_BASE_BRANCH=main
GITLAB_WEBHOOK_SECRET=<random secret>
```

Redeploy the worker after changing environment variables.

## Create the token

Prefer a Project Access Token when your GitLab.com plan and project settings allow one. If a Project Access Token is unavailable, use a dedicated bot or service-account Personal Access Token.

Do not use a human day-to-day token for production automation.

Grant the token the `api` scope. ai-workflow needs GitLab REST API access for branches, merge requests, comments/discussions, commit statuses, project metadata, and REST API writes. Repository scopes such as `write_repository` are not a replacement for `api`; `write_repository` alone is not enough for REST API calls.

Save the token as `GITLAB_TOKEN`.

## Find the project ID

Set `GITLAB_PROJECT_ID` to either:

- The numeric project ID from the GitLab project overview.
- The project path in `namespace/project` form, for example `my-group/my-repo`.

The app URL-encodes project paths internally before calling the GitLab API.

## Configure the webhook

In the GitLab project, open **Project Settings -> Webhooks** and add:

- URL: `https://<worker-deployment>/webhooks/gitlab`
- Secret token: the same value as `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**
- SSL verification: enabled

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
