# GitLab Demo E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the complete Jira-to-GitLab ai-workflow loop against an isolated private GitLab project and the existing Vercel `ai-workflow-demo` custom environment: Jira ticket → AI change → merge request → human comment → AI follow-up change on the same merge request.

**Architecture:** Use a project-scoped GitLab bot token for `filipmaszota3/ai-workflow-integration-test`. Deploy the current worker to the `ai-workflow-demo` custom environment in `blazity/ai-workflow-app`, configure an isolated webhook, and use a dedicated Jira demo ticket to trigger the active workflow. Verify that the first AI run creates a real `blazebot/*` merge request, then add an external merge request comment and verify a second AI run updates the same branch and merge request.

**Tech Stack:** GitLab.com REST API and Git-over-HTTPS, GitLab CI, Vercel CLI custom environments, Nitro worker.

## Global Constraints

- Do not modify the unrelated Vercel project `blazity/ai-workflow-demo`.
- Do not replace production GitLab secrets in `blazity/ai-workflow-app`.
- Store GitLab credentials only in Vercel custom environment `ai-workflow-demo`.
- Never print or commit token values or webhook secrets.
- Use GitLab Secret token verification, not the Signing token flow.
- Limit the GitLab token to `filipmaszota3/ai-workflow-integration-test`.
- Use a dedicated Jira demo ticket and do not alter an existing production ticket.
- The deployed workflow must enable the initial Jira trigger and `trigger_pr_review` with GitLab provider plus `commented`.

---

### Task 1: Create and validate the GitLab demo bot

**Files:**
- No repository files changed.

**Interfaces:**
- Consumes: Maintainer access from the authenticated `filipmaszota3` GitLab account.
- Produces: a project access token with `api` and `write_repository`, its bot username, and a random webhook secret.

- [ ] **Step 1: Create a 30-day Maintainer project access token**

Run a `POST projects/filipmaszota3%2Fai-workflow-integration-test/access_tokens` request with:

```json
{
  "name": "ai-workflow-demo-bot",
  "description": "Temporary token for the ai-workflow GitLab E2E demo",
  "scopes": ["api", "write_repository"],
  "access_level": 40,
  "expires_at": "2026-08-22"
}
```

Expected: HTTP success containing a one-time `token`, token ID, and bot `user_id`. If GitLab.com rejects project tokens because of the account tier, stop before changing Vercel and use a dedicated service-account PAT instead.

- [ ] **Step 2: Validate the bot**

Use the returned token against:

```text
GET https://gitlab.com/api/v4/user
GET https://gitlab.com/api/v4/projects/filipmaszota3%2Fai-workflow-integration-test
```

Expected: both return `200`; record the bot username without printing the token.

- [ ] **Step 3: Generate the webhook secret**

Run:

```bash
openssl rand -hex 32
```

Expected: a 64-character lowercase hexadecimal value retained only in memory.

### Task 2: Configure and deploy the isolated Vercel target

**Files:**
- No source files changed.

**Interfaces:**
- Consumes: bot token, bot username, webhook secret, current worker source.
- Produces: a ready deployment using the Vercel `ai-workflow-demo` custom environment.

- [ ] **Step 1: Set target-scoped environment variables**

Add or update these variables only for `ai-workflow-demo` in project `blazity/ai-workflow-app`:

```text
GITLAB_TOKEN=<value retained in memory>
GITLAB_WEBHOOK_SECRET=<value retained in memory>
GITLAB_HOST=https://gitlab.com
GITLAB_PROJECT_ID=filipmaszota3/ai-workflow-integration-test
GITLAB_BASE_BRANCH=main
GITLAB_BOT_LOGIN=<username returned by GET /user>
```

Expected: `vercel env ls ai-workflow-demo --cwd apps/worker --scope blazity` lists all six names without exposing values.

- [ ] **Step 2: Deploy the worker**

Run:

```bash
vercel deploy --target=ai-workflow-demo --cwd apps/worker --scope blazity --yes
```

Expected: deployment reaches `Ready`.

- [ ] **Step 3: Assign and verify the stable demo alias**

Assign the ready deployment to:

```text
https://ai-workflow-gitlab-demo.vercel.app
```

Verify:

```text
GET  /health           -> 200
POST /webhooks/gitlab  -> 401 when X-Gitlab-Token is missing
```

### Task 3: Register and validate the GitLab webhook

**Files:**
- No repository files changed.

**Interfaces:**
- Consumes: stable demo URL and webhook secret.
- Produces: a GitLab project webhook subscribed to merge request, pipeline, and note events.

- [ ] **Step 1: Create the webhook**

Run `POST /projects/filipmaszota3%2Fai-workflow-integration-test/hooks` with:

```json
{
  "name": "ai-workflow GitLab demo",
  "url": "https://ai-workflow-gitlab-demo.vercel.app/webhooks/gitlab",
  "merge_requests_events": true,
  "pipeline_events": true,
  "note_events": true,
  "enable_ssl_verification": true,
  "token": "<value retained in memory>"
}
```

Expected: response contains a hook ID, the exact URL, the three enabled event flags, and SSL verification enabled.

- [ ] **Step 2: Confirm endpoint authentication**

Send an invalid direct request and a request using the configured secret.

Expected: invalid secret returns `401`; valid secret passes token verification and returns a non-authentication response.

### Task 4: Exercise the complete merge request flow

**Files:**
- Modify in demo repository: `README.md`

**Interfaces:**
- Consumes: project bot token, webhook, deployed worker.
- Produces: a real bot branch, merge request, webhook delivery, and GitLab commit status.

- [ ] **Step 1: Create and push the bot branch**

Clone using Git-over-HTTPS as the project bot, create branch `blazebot/DEMO-1`, append one harmless line to `README.md`, commit as the bot, and push.

Expected: push succeeds using only the project access token.

- [ ] **Step 2: Open the merge request through the GitLab API**

Create an MR from `blazebot/DEMO-1` to `main` titled:

```text
test: verify ai-workflow GitLab integration
```

Expected: GitLab returns the new MR IID and URL.

- [ ] **Step 3: Verify webhook delivery**

Query:

```text
GET /projects/:id/hooks/:hook_id/events
```

Expected: a successful `Merge Request Hook` delivery to the stable demo URL with HTTP `2xx`.

- [ ] **Step 4: Verify the post-PR gate**

Query commit statuses for the MR head SHA.

Expected: a `blazebot / code-hygiene` status appears and reaches a terminal state.

- [ ] **Step 5: Verify comment delivery**

Post a harmless external MR comment, then query webhook events.

Expected: a successful `Note Hook` delivery. The test only verifies delivery unless the active workflow definition enables the GitLab `commented` trigger.

### Task 5: Exercise Jira → AI → MR → comment → AI follow-up

**Files:**
- No worker source files changed.
- The AI run modifies files only in `filipmaszota3/ai-workflow-integration-test`.

**Interfaces:**
- Consumes: deployed demo worker, Jira demo credentials, GitLab bot token, active workflow definition.
- Produces: a Jira-triggered AI run, GitLab merge request, external review comment, and a second AI-authored commit on the same branch.

- [ ] **Step 1: Audit the deployed workflow definition**

Read the demo worker workflow definition and verify:

```text
initial trigger: Jira ticket entering the configured AI column
review trigger: trigger_pr_review
review providers: includes gitlab
review states: includes commented
review scope: workflow_owned
```

Expected: both triggers are enabled. If either trigger is missing, configure a minimal demo-only workflow definition before creating the Jira ticket.

- [ ] **Step 2: Create a dedicated Jira demo ticket**

Create a ticket in the configured demo Jira project with:

```text
Summary: GitLab E2E demo — update README
Description: Add a short "AI workflow E2E verified" section to README.md in filipmaszota3/ai-workflow-integration-test. Keep the change documentation-only.
Acceptance criteria:
- README.md contains the new section.
- A merge request targets main.
- The branch starts with blazebot/.
```

Expected: a new Jira issue key is returned.

- [ ] **Step 3: Trigger and observe the first AI run**

Move the demo ticket to the configured AI column/transition and observe the worker run.

Expected:

```text
run succeeds
branch is blazebot/<ticket-key>
one merge request targets main
README.md contains the requested section
Jira ticket records the run or merge request according to the active workflow
```

- [ ] **Step 4: Add an external merge request comment**

Post this comment as the human `filipmaszota3` account, not the project bot:

```text
Please update the new E2E section to mention that the follow-up change was triggered from a GitLab merge request comment.
```

Expected: GitLab emits a successful `Note Hook` delivery and the worker dispatches a `trigger_pr_review` run with state `commented`.

- [ ] **Step 5: Observe the follow-up AI run**

Expected:

```text
the follow-up run succeeds
the existing blazebot/<ticket-key> branch receives a new AI-authored commit
the existing merge request is reused rather than duplicated
README.md includes the requested follow-up sentence
the merge request head SHA changes
```

- [ ] **Step 6: Verify audit evidence**

Record the Jira issue key, both run IDs, merge request URL and IID, before/after head SHAs, successful Merge Request Hook and Note Hook event IDs, and final commit status.

### Task 6: Final verification and cleanup decision

**Files:**
- No additional files changed.

**Interfaces:**
- Consumes: all resource IDs and test evidence, including Jira and both AI runs.
- Produces: an evidence-backed pass/fail report and explicit cleanup options.

- [ ] **Step 1: Run the verification checklist**

Verify the token is project-scoped and active, Vercel target is ready, health is `200`, webhook events are successful, the Jira-triggered MR exists on `blazebot/<ticket-key>`, the expected commit status is terminal, the review comment dispatched a second run, and the same MR contains the follow-up commit.

- [ ] **Step 2: Preserve demo resources**

Keep the MR, webhook, Vercel target variables, and bot token available for repeat testing unless the user explicitly requests cleanup. Report the token expiration date `2026-08-22`.
