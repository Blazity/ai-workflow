# GitHub App setup

Step-by-step guide for registering a GitHub App for the ai-workflow bot and collecting the four env vars the deployment needs.

This replaces the previous "personal access token" setup. The App is **organization-owned** so it survives the creator leaving the org.

---

## What you'll end up with

Required GitHub provider values to set on the Vercel deployment:

```bash
GITHUB_APP_ID=<numeric app id>
GITHUB_APP_PRIVATE_KEY=<base64 of the .pem file>
GITHUB_INSTALLATION_ID=<numeric installation id>
GITHUB_WEBHOOK_SECRET=<random hex, used to sign pull_request webhook deliveries>
```

`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, and `VCS_KIND=github` are legacy single-repo defaults. They may remain set for older deployments, but multi-repo runs discover repositories from the GitHub App installation permissions instead.

You can configure GitHub and GitLab in the same deployment. Provider credentials are additive.

---

## 1. Open the org's developer settings

Navigate to:

```text
https://github.com/organizations/<YOUR-ORG>/settings/apps
```

Or click through: **org page → Settings → Developer settings → GitHub Apps**.

Click **"New GitHub App"**.

## 2. Fill in basics

| Field | Value |
|---|---|
| GitHub App name | `blazity-ai-workflow` (must be globally unique on github.com) |
| Homepage URL | Your Vercel deployment URL, or any valid URL |
| Description | Optional |

## 3. Configure the webhook

The bot receives GitHub `pull_request` events to drive the post-PR gate (see [post-pr-gate-spec.md](./post-pr-gate-spec.md)). The webhook URL points at the deployment's `/webhooks/github` route and is signed with a shared secret.

- **Webhook → Active** → **checked**
- **Webhook URL** → `https://<your-deployment>/webhooks/github` (use the production URL once you have one; you can set a placeholder now and update after first deploy)
- **Webhook secret** → generate a random value and paste it:

  ```bash
  openssl rand -hex 32
  ```

  Save the same value as `GITHUB_WEBHOOK_SECRET` in Vercel (step 11). The deployment validates `X-Hub-Signature-256` on every delivery — a missing or mismatched secret returns 401.

> No need to subscribe to events yet — the next step (permissions) gates which event types are available, and event subscription is configured separately in step 5.

## 4. Set permissions

### Repository permissions

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | Clone the repo, push commits |
| Pull requests | Read & write | Create PRs, fetch PR data |
| Issues | Read & write | PR review comments live on the issues API |
| Checks | Read & write | Read CI check results + create post-PR gate check runs |
| Actions | Read-only | Read workflow run status |
| Metadata | Read-only | Mandatory, auto-included |

Leave all other repository permissions on **No access**.

### Organization permissions

Leave everything on **No access**.

### Account permissions

Leave everything on **No access**.

## 5. Subscribe to events

Under **Subscribe to events**, enable exactly one:

- **Pull request** — fires the `pull_request` event on `opened` / `synchronize` / `reopened` / `closed`. The deployment filters to the actions it cares about; subscribing to the umbrella event is required.

Leave every other event unchecked.

## 6. Choose installation scope

**Where can this GitHub App be installed?**

- **Only on this account** — restricts to your org. Pick this for the single-tenant-per-deployment model (one Vercel deployment serves one org).
- **Any account** — only needed if external clients self-install. Not the default.

Click **"Create GitHub App"**.

## 7. Generate a private key

On the new App's page, scroll down to **"Private keys"** → click **"Generate a private key"**.

GitHub downloads a file like `blazity-ai-workflow.2026-05-07.private-key.pem`.

> Save this file. GitHub never shows it again. If lost, generate a new key from this page and revoke the old one.

## 8. Note the App ID

At the top of the App settings page:

```text
App ID: 1234567
```

That number is your `GITHUB_APP_ID`.

## 9. Install the App on the target repo

On the App's page, click **"Install App"** in the left sidebar.

1. Click **"Install"** next to the org that owns the target repo.
2. Choose **"Only select repositories"**.
3. Pick the repo(s) the bot will operate on.
4. Click **"Install"**.

> **Re-accepting after permission changes.** GitHub flags the installation as "pending acceptance" on every installed repo whenever you change permissions (e.g. raising `Checks` to read & write, or adding the `Pull request` event subscription). A repo admin must click "Review request" at `https://github.com/organizations/<ORG>/settings/installations/<INSTALLATION_ID>` and accept the new permission set — until they do, the new permissions are inert and the post-PR gate webhook will fail silently.

## 10. Get the Installation ID

The Installation ID is a numeric identifier that scopes the App to one specific
install (org-or-user × selected repos). It's distinct from the App ID.

Pick whichever of the three paths below matches your situation.

### Path A — right after installing (easiest)

Immediately after step 8, GitHub redirects you to the configuration page. Copy
the trailing number from the browser URL:

```text
# Org install:
https://github.com/organizations/<ORG>/settings/installations/<INSTALLATION_ID>
                                                              ^^^^^^^^^^^^^^^^^

# Personal-account install:
https://github.com/settings/installations/<INSTALLATION_ID>
                                          ^^^^^^^^^^^^^^^^^
```

### Path B — finding it later (org install)

1. Go to your org's page on github.com.
2. Click **Settings** (top tab).
3. In the left sidebar: **Integrations → GitHub Apps**.
4. Find your App in the list and click **Configure**.
5. The browser URL is now the same as Path A — grab the trailing number.

You need org-owner or app-manager permissions to see this page.

### Path C — finding it later (personal-account install)

1. Click your avatar (top right) → **Settings**.
2. Left sidebar: **Applications → Installed GitHub Apps**.
3. Click **Configure** next to your App.
4. The trailing number in the URL is your Installation ID.

### Path D — programmatically (sanity check)

If you have the App ID and private key but want to confirm the Installation ID,
list installations from the App's identity:

```bash
# Generate an App JWT (10-min lifetime), then:
curl -H "Authorization: Bearer $APP_JWT" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/app/installations
```

Each entry has an `id` field — that's the Installation ID. If your App is
installed in multiple places (e.g. several orgs), you'll see one entry per
install; pick the one whose `account.login` matches `GITHUB_OWNER`.

> Each org/user that installs the App gets its **own** Installation ID. If you
> later install the App on a second org, that's a new ID — don't reuse the old
> one.

## 11. Base64-encode the private key

The deployment expects the PEM as a single-line base64 string (multi-line PEM does not round-trip cleanly through Vercel's env UI):

```bash
base64 -i blazity-ai-workflow.2026-05-07.private-key.pem | tr -d '\n' | pbcopy
```

The clipboard now holds your `GITHUB_APP_PRIVATE_KEY`.

> **macOS note:** `base64 -i` works on macOS. On Linux use `base64 -w 0 < <file>`.

## 12. Set the env vars on Vercel

```bash
GITHUB_APP_ID=1234567
GITHUB_APP_PRIVATE_KEY=<paste the base64 string>
GITHUB_INSTALLATION_ID=98765432
GITHUB_WEBHOOK_SECRET=<the same secret you pasted in step 3>
```

Optional legacy single-repo defaults:

```bash
GITHUB_OWNER=<target-org>
GITHUB_REPO=<target-repo>
GITHUB_BASE_BRANCH=main
VCS_KIND=github
```

Set them in **Vercel → project → Settings → Environment Variables** for the appropriate environments (Production / Preview / Development as needed). `GITHUB_WEBHOOK_SECRET` is required in **every** environment — the webhook fires on preview deployments too, and the handler returns 401 without it.

## 13. Redeploy

The bot validates env vars at startup. After setting the values, trigger a redeploy so the new env is loaded.

---

## Rotating the private key

1. Generate a new key from the App settings page (step 6).
2. Update `GITHUB_APP_PRIVATE_KEY` on Vercel with the base64 of the new `.pem`.
3. Redeploy.
4. **Then** revoke the old key from the App settings page.

Order matters — revoke last, otherwise the running deployment loses auth before the new key is live.

## Removing the App from a repo

Org **Settings → Integrations → GitHub Apps → Configure** → uncheck the repo or click **Uninstall**.

The deployment will start failing on the next workflow run because installation tokens are scoped to installed repos.
