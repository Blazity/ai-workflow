# Bitbucket

Bitbucket Cloud (bitbucket.org, REST API 2.0) as a version control provider,
beside GitHub and GitLab: a deployment that connects it can import a
workspace's repositories into the catalog, and its workflows clone and push
branches there, open and update pull requests, read and answer review
comments, publish reviews, post build statuses and Code Insights reports on a
commit, and start on the workspace's pull request events.

Bitbucket Data Center (self-hosted) has another API and is not covered.

## Which credential, and why

An **access token**: a workspace access token for a deployment that works
across a workspace, or a project or repository access token for a narrower
one. All three authenticate the same way (`Authorization: Bearer <token>` for
the API, the user `x-token-auth` with the token as password for git), so the
package has one code path for them.

The alternatives were weighed and left out:

- **App passwords** are on their way out: Atlassian's API token page calls API
  tokens "the long term replacement for App passwords", so a package written
  today against one would ship against a credential being withdrawn.
- **API tokens** belong to a person's Atlassian account: every comment and
  push would be that person's, the token stops when they leave, and the REST
  API wants their email beside it. An access token is not tied to a user
  account; Bitbucket shows it under the token's own name, which is what a
  bot account should look like, and an admin can revoke it without touching
  anybody's login.

The cost: workspace and project access tokens need a Bitbucket Cloud Premium
plan. On Standard only a repository access token is available, and it reaches
its one repository, so a deployment connected with one works on that
repository alone. Premium is the realistic setup for a workspace.

## Connecting it

| Field | Variable | Required | What it is |
|---|---|---|---|
| Workspace | `BITBUCKET_WORKSPACE` | yes | The workspace ID, the slug in `bitbucket.org/<workspace>/...`. |
| Access token | `BITBUCKET_ACCESS_TOKEN` | yes | A workspace, project or repository access token. Secret. |
| Bot account | `BITBUCKET_BOT_LOGIN` | no | The access token's name as Bitbucket shows it on comments, or its account UUID. |
| Webhook secret | `BITBUCKET_WEBHOOK_SECRET` | required for stored values | The secret set on the repository webhook. Secret. |

Create the token under the workspace's (or project's, or repository's)
**Settings, Security, Access tokens**, with these scopes:

- `repository:write` (implies `repository`): clone, push, branches, files, build statuses and reports;
- `pullrequest:write` (implies `pullrequest`): pull requests, comments, approvals;
- `webhook`: only if the same token should manage the webhook.

Set **Bot account** to the token's name. Bitbucket answers `GET /user` only
for a token with the `account` scope, which only a workspace access token can
carry; without it the bot account is the only way the package recognises its
own comments, and a run would otherwise read its own replies back as review
feedback.

Commits pushed by an agent carry the identity in `COMMIT_AUTHOR` and
`COMMIT_EMAIL` when the deployment sets them. Bitbucket matches git activity to
an access token by the email `<token id>@bots.bitbucket.org` (shown on the
token's page); set `COMMIT_EMAIL` to it for commits Bitbucket attributes to the
token.

**The webhook.** In the repository's **Settings**, under **Workflow**,
**Webhooks**, **Add webhook**, add one to `https://<worker>/webhooks/bitbucket` with a secret, and, under
**Choose from a full list of triggers**, the triggers: Pull request Created, Updated, Merged, Comment created, Changes
Request created, and Repository Build status created and updated. Put the same
secret in **Webhook secret**.

An admin can set the variables on the deployment, or type the values on the
Integrations page, where saving tests them before they are used. The test
lists one repository of the workspace with the token, and its message names
the workspace and how many repositories the token sees.

## What connecting it unlocks

- The `vcs` capability for repositories whose provider is `bitbucket`: the
  catalog's import lists the workspace's repositories, and every block that
  works on a pull request works on a Bitbucket one.
- Gate statuses as build statuses on the head commit, and their details as a
  Code Insights report (`report_type` BUG) with one annotation per finding, at
  most 1,000.
- Published reviews: one inline comment thread per finding, carried across
  rounds and resolved (with a note saying it was superseded) once a round stops
  reporting it; one summary comment edited in place; the decision as an
  approval or a change request, best effort.
- Triggers from the webhook: pull request created, ready, updated, merged,
  review (a comment, or a change request), and checks failed (a failed build
  status on an open pull request's head).
- The **API access** and **Repository access** rows on the System health page.

## How Bitbucket differs, and what the package does about it

- **Abbreviated hashes.** Bitbucket puts 12-character hashes on a pull request.
  Core compares heads by the full hash, so the adapter and the webhook resolve
  each one through `GET .../commit/<hash>`: one extra request per pull request
  event.
- **No previous head on an update.** `pullrequest:updated` fires for a push and
  for an edit of the title alike. The update trigger is keyed by its head, so
  an edit that moved nothing never starts a second run for that head; the first
  update delivery for a head does start one, even if it was an edit.
- **No previous draft state.** "Ready" is keyed by the pull request and fires
  once, on the first delivery that shows it open and not a draft.
- **A build status names no pull request.** The webhook reads the first 50 open
  pull requests and keeps those whose head is that commit.
- **Build status producers.** A trigger names a failed status's producer by its
  `key`. Any account with write access can post a status under any key, so none
  is trusted by default: a checks-failed trigger must name its producers.
- **No merge commits through the API.** The source API accepts one parent, so a
  push that would merge (`mergeParentSha`) is refused.
- **Single-line annotations.** A Code Insights annotation sits on one line; a
  finding over a range is placed at its first line.
- **Limits not in the reference.** The API reference states no length for a
  build status description or a report's details; the package keeps them to
  255 and 2,000 characters, keeping both ends of a longer text. A 403 whose
  message speaks of scopes is read as a token without the scope rather than a
  pull request this token may not read; that wording was not confirmed against
  a live answer. Bitbucket documents rate limits per hour and the headers it
  sends near one, but no `Retry-After` on a 429.

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, connection fields, the `vcs` capability, repository shape, health checks. Plain data. |
| `worker.ts` | The connection test, the health probes, the adapter factory and the handle identity. |
| `client.ts` | Every request, through `ctx.http`, with the token; pagination; Bitbucket's error as an error. |
| `vcs.ts` | The `vcs` adapter: branches, commits, pull requests, comments, review threads, reviews, statuses, reports. |
| `checks.ts` | Build statuses as failed checks and their handles; which account is this deployment's own. |
| `webhook.ts` | Signature verification and the pull request events as triggers. |
| `profile-source.ts` | What a repository says about itself (README, manifests, `bitbucket-pipelines.yml`). |
| `test-support.ts`, `*.test.ts`, `test-fixtures/` | A Bitbucket that is a function, the tests, and payloads with their sources. |

## Provider documentation this is written against

| What | Where | Read on |
|---|---|---|
| Access tokens: kinds, Premium requirement, Bearer and `x-token-auth`, bot email | https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/, `.../using-access-tokens/`, `.../using-workspace-access-tokens/` | 2026-11-10 |
| Access token scopes | `.../repository-access-token-permissions/`, `.../project-access-token-permissions/`, `.../workspace-access-token-permissions/` | 2026-11-10 |
| API tokens (the alternative left out) | https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/ | 2026-11-10 |
| Every call this package makes (paths, bodies, states, `parents`, statuses, reports, annotations, comments and their resolution) | The Bitbucket Cloud OpenAPI description, https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json (SHA-256 35956399bf8d41d2acfd099b3d94ef1a08e0cfd6409a92077b94a1dacbc6abdc that day); the rendered reference at developer.atlassian.com is generated from it | 2026-11-10 |
| Webhook signature (`X-Hub-Signature: sha256=<hex>`) and its test vectors | https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/ | 2026-11-10 |
| Event keys, delivery headers, payload shapes | https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/ | 2026-11-10 |
| Rate limits | https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/ | 2026-11-10 |

The payloads in `test-fixtures/` are composed from the event payload page's
samples, and the signature vectors are the ones the webhook page publishes;
each `.source.txt` says how. None was recorded from a live delivery: no test
account was available, so every behaviour above was checked against the
documentation and the tests, not against Bitbucket itself.
