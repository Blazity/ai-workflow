# GitHub Personal Access Token

## Mint the token

1. Open https://github.com/settings/tokens/new (classic) or https://github.com/settings/personal-access-tokens/new (fine-grained).
2. **Classic PAT** — simpler:
   - Note: `blazebot`
   - Expiration: 90 days (set a calendar reminder)
   - Scopes: check **`repo`** (full control of private repositories). That single scope grants everything Blazebot needs: read/write code, branches, PRs, issues.
3. **Fine-grained PAT** — narrower blast radius:
   - Resource owner: the org or user that owns the repo
   - Repository access: **Only select repositories** → pick your repo
   - Permissions:
     - Contents: **Read and write**
     - Pull requests: **Read and write**
     - Metadata: **Read-only** (auto-required)
4. Click **Generate token** and copy it immediately — GitHub won't show it again.

## Find owner and repo

If your repo URL is `https://github.com/acme-corp/blazebot-target`:
- `GITHUB_OWNER=acme-corp`
- `GITHUB_REPO=blazebot-target`

Don't put the slash or the full URL — just the two halves separately.

## Verify

```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO | \
  jq '.full_name, .permissions'
```

Should print the repo's `full_name` and a permissions object showing `push: true`. A 401 means the token is wrong; a 404 means the token works but lacks access to that repo (fine-grained PAT scoped to a different repo, etc.).

## Rotation

PATs are bearer credentials. Rotate quarterly:
1. Mint a new token.
2. Update Vercel env (`vercel env rm GITHUB_TOKEN production && vercel env add GITHUB_TOKEN production`).
3. Redeploy: `vercel --prod`.
4. Revoke the old token in GitHub settings.
