# GitLab Personal Access Token

## Mint the token

1. Open https://gitlab.com/-/user_settings/personal_access_tokens (or `<GITLAB_HOST>/-/user_settings/personal_access_tokens` for self-hosted).
2. Token name: `blazebot`
3. Expiration: 90 days (set a calendar reminder)
4. Scopes: check **`api`** — this grants read/write to repository, MRs, issues. (`read_api` + `write_repository` is narrower but Blazebot's adapter currently expects full `api`.)
5. Click **Create personal access token** and copy it immediately. The token starts with `glpat-`.

## Find `GITLAB_PROJECT_ID`

Two formats both work:

- **Path with namespace:** `acme-corp/blazebot-target` (mirrors the URL `https://gitlab.com/acme-corp/blazebot-target`)
- **Numeric ID:** find at Settings → General → Project ID (top of page)

Path format is more readable; numeric ID is stable across renames.

## `GITLAB_HOST`

- **gitlab.com:** skip the var (defaults to `https://gitlab.com`).
- **Self-hosted:** set `GITLAB_HOST=https://gitlab.example.com` (no trailing slash, no `/api/v4`).

## Verify

```bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_HOST/api/v4/projects/$(printf '%s' "$GITLAB_PROJECT_ID" | jq -sRr @uri)" | \
  jq '.path_with_namespace, .permissions'
```

Should print the project path and permissions. A 401 → bad token. A 404 → token works but no access to that project.

## Rotation

`glpat-` tokens are bearer credentials. Rotate quarterly:
1. Mint a new token in GitLab.
2. Update Vercel env (`vercel env rm GITLAB_TOKEN production && vercel env add GITLAB_TOKEN production`).
3. Redeploy: `vercel --prod`.
4. Revoke the old token in GitLab settings.
