---
name: init-vcs
description: Configure or rotate the VCS provider (GitHub or GitLab) for the Blazebot workflow. Branches on provider choice and emits a single paste-template for that provider only. Use for "set up github", "set up gitlab", "rotate github token", "switch vcs provider", "configure vcs".
---

# Initialize VCS provider

Branch-on-choice skill. Asks **GitHub, GitLab, or both**, then emits a paste-template per chosen provider. Provider credentials are additive in `env.ts`: a deployment may configure GitHub (GitHub App vars), GitLab (`GITLAB_TOKEN` + `GITLAB_PROJECT_ID`), or both at once. `VCS_KIND` is optional and only pins the legacy single-repo helpers; leave it unset in a dual-provider deployment. The cross-field rule (`VCS_KIND=github` requires the GitHub App vars; `VCS_KIND=gitlab` requires `GITLAB_TOKEN`) is enforced by construction.

> If you want full project setup (Jira + VCS + Agent + Slack + Neon + deploy), invoke `init-env` instead. This skill only handles VCS.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1 — Pick provider

Ask: *"GitHub, GitLab, or both?"*

Providers coexist: adding GitLab does NOT require removing `GITHUB_*` keys (and vice versa). A dual-provider deployment lists repositories from both providers in one catalog and a single run can mix them. Only when the user explicitly wants to DROP a provider should they remove that provider's keys; print a one-line note in that case. For "both", also collect per-provider bot logins (`GITHUB_BOT_LOGIN`, `GITLAB_BOT_LOGIN`) instead of the legacy `VCS_BOT_LOGIN`, and leave `VCS_KIND` unset.

## Step 2 — Emit paste-template

### GitHub branch

GitHub auth uses a GitHub App (the legacy `GITHUB_TOKEN` PAT flow was removed; see `docs/GITHUB-APP-SETUP.md`). Collect:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (base64), `GITHUB_INSTALLATION_ID`
- `GITHUB_OWNER` (org or user)
- `GITHUB_REPO` (just the repo name)
- `GITHUB_BASE_BRANCH` (default `main`)
- `GITHUB_WEBHOOK_SECRET` (`openssl rand -hex 32`)

Emit (paste into Vercel → Project Settings → Environment Variables, all three environments):

```
VCS_KIND=github
GITHUB_APP_ID=<value>
GITHUB_APP_PRIVATE_KEY=<base64 PEM>
GITHUB_INSTALLATION_ID=<value>
GITHUB_OWNER=<value>
GITHUB_REPO=<value>
GITHUB_BASE_BRANCH=main
GITHUB_WEBHOOK_SECRET=<value>
```

(Omit the `VCS_KIND` line when configuring both providers.)

### GitLab branch

Walk the user through `references/gitlab-pat.md` to mint a token. Then collect:

- `GITLAB_TOKEN` (`glpat-...`)
- `GITLAB_PROJECT_ID` (e.g. `your-group/your-repo`, or numeric ID — both work)
- `GITLAB_BASE_BRANCH` (default `main`)
- `GITLAB_HOST` (skip for `gitlab.com`; set for self-hosted)

Emit:

```
VCS_KIND=gitlab
GITLAB_TOKEN=<value>
GITLAB_PROJECT_ID=<value>
GITLAB_BASE_BRANCH=main
```

If self-hosted, append:
```
GITLAB_HOST=https://gitlab.example.com
```

## Step 3 — Done

Tell the user to paste, save, and reply when done. No verification — `init-env`'s end-of-flow validator catches missing/malformed values.

If invoked from `init-env`, return control. If standalone, end.

## Don'ts

- **Don't emit both branches unless the user chose "both".** For a single-provider setup, emitting both invites stale keys. For a deliberate dual-provider setup, emit both templates, drop the `VCS_KIND` lines, and add `GITHUB_BOT_LOGIN`/`GITLAB_BOT_LOGIN`.
- **Don't print the token after collecting it.** Reference by name only.
