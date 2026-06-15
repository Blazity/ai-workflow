---
name: init-vcs
description: Configure or rotate the VCS provider (GitHub or GitLab) for the Blazebot workflow. Branches on provider choice and emits a single paste-template for that provider only. Use for "set up github", "set up gitlab", "rotate github token", "switch vcs provider", "configure vcs".
---

# Initialize VCS provider

Branch-on-choice skill. Asks **GitHub or GitLab**, then emits a single paste-template for the chosen provider. The cross-field rule in `env.ts` (`VCS_KIND=github` requires `GITHUB_TOKEN` + `GITHUB_OWNER` + `GITHUB_REPO`; `VCS_KIND=gitlab` requires `GITLAB_TOKEN` + `GITLAB_PROJECT_ID`) is enforced by construction — only the chosen branch's keys are emitted.

> If you want full project setup (Jira + VCS + Agent + Slack + Neon + deploy), invoke `init-env` instead. This skill only handles VCS.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1 — Pick provider

Ask: *"GitHub or GitLab?"*

If switching from a previously-configured provider, the user should also remove the old branch's keys from Vercel (`GITHUB_*` if switching to GitLab, vice versa). Print a one-line warning and let them handle it.

## Step 2 — Emit paste-template

### GitHub branch

Walk the user through `references/github-pat.md` to mint a token, find owner/repo. Then collect:

- `GITHUB_TOKEN` (PAT with `repo` scope)
- `GITHUB_OWNER` (org or user)
- `GITHUB_REPO` (just the repo name)
- `GITHUB_BASE_BRANCH` (default `main`)

Emit (paste into Vercel → Project Settings → Environment Variables, all three environments):

```
VCS_KIND=github
GITHUB_TOKEN=<value>
GITHUB_OWNER=<value>
GITHUB_REPO=<value>
GITHUB_BASE_BRANCH=main
```

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

- **Don't emit both branches.** Cross-field validation in `env.ts` will fail at validate time, but emitting both invites the user to paste both, leaving stale keys in Vercel even if validation passes (it does — only one set is *required*, the other is harmless until it's not).
- **Don't print the token after collecting it.** Reference by name only.
