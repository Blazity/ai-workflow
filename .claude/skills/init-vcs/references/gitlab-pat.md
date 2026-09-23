# GitLab Personal Access Token

## Mint the token

1. Open https://gitlab.com/-/user_settings/personal_access_tokens (or `<GITLAB_HOST>/-/user_settings/personal_access_tokens` for self-hosted).
2. Token name: `ai-workflow`
3. Expiration: 90 days (set a calendar reminder)
4. Scopes: check **`api`** and **`write_repository`**, as [GITLAB-SETUP.md](../../../../docs/runbooks/GITLAB-SETUP.md#create-the-token) requires.
5. Click **Create personal access token** and copy it immediately. The token starts with `glpat-`.

## `GITLAB_PROJECT_ID`

Leave it unset. It is a legacy single-project filter: when set, webhooks from every other project are ignored. Repositories are imported on the Repositories page.

## `GITLAB_HOST`

- **gitlab.com:** skip the var (defaults to `https://gitlab.com`).
- **Self-hosted:** set `GITLAB_HOST=https://gitlab.example.com` (no trailing slash, no `/api/v4`).

## Verify

```bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "${GITLAB_HOST:-https://gitlab.com}/api/v4/user" | jq '.username'
```

Should print the token account's username (the value for `GITLAB_BOT_LOGIN`). A 401 means a bad token.

## Rotation

`glpat-` tokens are bearer credentials. Rotate quarterly:
1. Mint a new token in GitLab.
2. Update Vercel env (`vercel env rm GITLAB_TOKEN production && vercel env add GITLAB_TOKEN production`).
3. Redeploy: `vercel --prod`.
4. Revoke the old token in GitLab settings.
