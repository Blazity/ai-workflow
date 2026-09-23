---
name: init-vcs
description: Configure or rotate the VCS provider (GitHub or GitLab) for the AI Workflow workflow. Branches on provider choice and emits a single paste-template for that provider only. Use for "set up github", "set up gitlab", "rotate github token", "switch vcs provider", "configure vcs".
---

# Initialize VCS provider

Branch-on-choice skill. Asks **GitHub, GitLab, or both**, then emits a paste-template per chosen provider. GitHub and GitLab are integrations (ADR-010): each declares its own variables in `integrations/<id>/manifest.ts`, a deployment may connect either or both, and which provider serves a repository comes from the repository record. No variable picks a provider.

The variables below still configure them, and a deployment that already sets them needs nothing done. The alternative, which needs no redeploy, is the **Integrations** page in the dashboard: open the GitHub or GitLab card, paste the same values, press **Test**. Either way the card is where an admin sees whether the provider is connected and reads its health checks.

> **Canonical reference:** [SETUP.md section 2.2](../../../SETUP.md#22-github-or-gitlab) holds the facts and constraints for both providers, and the runbooks [GITHUB-APP-SETUP.md](../../../docs/runbooks/GITHUB-APP-SETUP.md) and [GITLAB-SETUP.md](../../../docs/runbooks/GITLAB-SETUP.md) hold each provider's permission, scope and webhook event lists. This skill is the procedure; when they disagree, those documents win and this skill gets updated.
>
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

Providers coexist: adding GitLab does NOT require removing `GITHUB_*` keys (and vice versa). A dual-provider deployment lists repositories from both providers in one catalog and a single run can mix them. Only when the user explicitly wants to DROP a provider should they remove that provider's keys; print a one-line note in that case. For "both", also collect per-provider bot logins (`GITHUB_BOT_LOGIN`, `GITLAB_BOT_LOGIN`) instead of the legacy `VCS_BOT_LOGIN`.

## Step 2 — Emit paste-template

### GitHub branch

GitHub auth uses a GitHub App (the legacy `GITHUB_TOKEN` PAT flow was removed; see [docs/runbooks/GITHUB-APP-SETUP.md](../../../docs/runbooks/GITHUB-APP-SETUP.md)). Collect:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the PEM or its base64), `GITHUB_INSTALLATION_ID`
- `GITHUB_WEBHOOK_SECRET` (`openssl rand -hex 32`). Without it every delivery is refused with 503.
- Optional `GITHUB_BOT_LOGIN` (usually `<app-slug>[bot]`), needed when a review trigger includes `commented`
- The App subscribes to all five events in [GITHUB-APP-SETUP.md section 5](../../../docs/runbooks/GITHUB-APP-SETUP.md#5-subscribe-to-events). Confirm it with the user; a shorter list makes triggers silently never fire.
- Repositories are imported on the Repositories page afterwards. Do not collect the legacy `GITHUB_OWNER`/`GITHUB_REPO`.

Before emitting, confirm the App subscribes to all five events (App settings, Permissions & events, Subscribe to events): **Pull request**, **Check run**, **Pull request review**, **Pull request review comment**, **Issue comment**. A missing one is a trigger that never fires, and nothing on this side says so except the Health page's GitHub check. Steps: [GITHUB-APP-SETUP.md §5](../../../docs/runbooks/GITHUB-APP-SETUP.md#5-subscribe-to-events).

Emit (paste into Vercel → Project Settings → Environment Variables, all three environments):

```
GITHUB_APP_ID=<value>
GITHUB_APP_PRIVATE_KEY=<base64 PEM>
GITHUB_INSTALLATION_ID=<value>
GITHUB_WEBHOOK_SECRET=<value>
```


### GitLab branch

Walk the user through `references/gitlab-pat.md` to mint a token. Then collect:

- `GITLAB_TOKEN` (`glpat-...`)
- `GITLAB_WEBHOOK_SECRET` (`openssl rand -hex 32`). Without it every delivery is refused with 503.
- Optional `GITLAB_BOT_LOGIN` (the token account's username), needed when a review trigger includes `commented`
- Repositories are imported on the Repositories page afterwards. Do not set the legacy `GITLAB_PROJECT_ID`: when set, webhooks from every other project are ignored (`integrations/gitlab/webhook.ts`).
- `GITLAB_HOST`, only for a self-hosted instance. It defaults to `https://gitlab.com` (`integrations/gitlab/manifest.ts`).

Emit:

```
GITLAB_TOKEN=<value>
GITLAB_WEBHOOK_SECRET=<value>
```

If self-hosted, append:
```
GITLAB_HOST=https://gitlab.example.com
```

## Step 3 — Done

Tell the user to paste, save, and reply when done. Provider values are not checked at boot: after the next deploy, open the GitHub or GitLab card on the Integrations page and press **Test**; its health checks name any missing or refused value. Then register the webhook (SETUP.md section 8).

If invoked from `init-env`, return control. If standalone, end.

## Don'ts

- **Don't emit both branches unless the user chose "both".** For a single-provider setup, emitting both invites stale keys. For a deliberate dual-provider setup, emit both templates and add `GITHUB_BOT_LOGIN`/`GITLAB_BOT_LOGIN`.
- **Don't print the token after collecting it.** Reference by name only.
