# Harness Profile preview canary

This canary is the rollout gate for Harness Profile authoring. Keep
`NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED=0` in the dashboard preview and
production environments until the full canary command passes against the exact
preview deployment under review.

Run:

```sh
pnpm test:e2e:harness-profiles:dry
pnpm test:e2e:harness-profiles
```

The dry command checks the fail-closed environment and fixture validation
without making network requests. The full command temporarily transfers the
preview's `trigger_ticket_ai` claim to three pre-provisioned canary workflows,
runs each one, and restores the exact original workflow in a `finally` block.
Run it only while the preview has no active workflows.

## Required preview fixtures

Create these once through the authenticated dashboard/API. Do not add a
canary-only authentication or dispatch endpoint.

1. One disabled, deployed v2 workflow pinned to the published
   `builtin-claude` version.
2. One disabled, deployed v2 workflow pinned to the published
   `builtin-codex` version.
3. One disabled, deployed v2 workflow pinned to the exact published custom
   profile version described below.
4. One currently enabled workflow that owns `trigger_ticket_ai`; its ID is the
   restore target.
5. One organization-owned custom profile with one published immutable version.
   That version must pin a GitHub-imported skill artifact at the expected
   artifact hash and exact source commit.

Each canary workflow must contain exactly:

```text
trigger_ticket_ai -> generic_agent
```

The Generic Agent must use `workspaceMode: "none"` and pin the expected exact
`{ profileId, version }`. This deliberately prevents repository writes, PRs,
ticket updates, and other workflow side effects. The ticket itself is the only
external fixture created by the canary and is deleted afterward.

## Required runner environment

The full command fails before changing preview state unless every value below
is present and valid:

```dotenv
# Exact protected preview target and an owner/admin Better Auth session.
HARNESS_CANARY_BASE_URL=https://your-preview.example
HARNESS_CANARY_EXPECTED_HOST=your-preview.example
HARNESS_CANARY_SESSION_TOKEN=...
HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS=run-preview-harness-canary
VERCEL_ENV=preview
VERCEL_AUTOMATION_BYPASS_SECRET=...

# This must remain disabled until the command succeeds.
NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED=0

# Existing enabled trigger owner, plus the three distinct disabled fixtures.
HARNESS_CANARY_RESTORE_WORKFLOW_ID=...
HARNESS_CANARY_CLAUDE_WORKFLOW_ID=...
HARNESS_CANARY_CODEX_WORKFLOW_ID=...
HARNESS_CANARY_CUSTOM_WORKFLOW_ID=...

# Exact immutable custom profile and GitHub skill provenance.
HARNESS_CANARY_CUSTOM_PROFILE_ID=...
HARNESS_CANARY_CUSTOM_PROFILE_VERSION=...
HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH=<64 lowercase hex characters>
HARNESS_CANARY_CUSTOM_SKILL_NAME=...
HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER=...
HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY=...
HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH=...
HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA=<40 lowercase hex characters>

# Jira trigger/cleanup and the same database branch used by the preview.
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=AIW
COLUMN_AI=AI
COLUMN_BACKLOG=Backlog
CRON_SECRET=...
DATABASE_URL=postgresql://...

# Optional, 60 seconds to 60 minutes; default 15 minutes per provider.
HARNESS_CANARY_TIMEOUT_MS=900000
```

The session token is the existing Better Auth bearer/session token for an
owner or admin in the configured dashboard organization. Never commit it or
print it. `DATABASE_URL` must address the exact preview database branch; the
gate cross-checks the API-visible custom profile against its stored immutable
skill relation and reads durable run provenance.

The deployed worker must already have working Claude, Codex, Jira, Workflow,
Vercel Sandbox, and GitHub App configuration. Those deployment secrets remain
inside the preview and are never copied into the runner. Successful live runs
are the proof that both provider credentials and runtime setup work.

## Checks performed

Before mutation, the command verifies:

- the URL host, `VERCEL_ENV=preview`, explicit mutation confirmation, preview
  protection bypass, and disabled authoring flag;
- the bearer session is authenticated as owner/admin;
- no workflow run is active;
- both stable built-in profiles are published;
- the custom profile is organization-owned, unarchived, and published at the
  exact requested version;
- its immutable version-to-skill relation matches the artifact hash, skill
  name, GitHub owner/repository/path, and commit SHA;
- all three canary workflows are deployed, disabled, v2, side-effect-free, and
  pin the expected exact profile version; and
- the configured restore workflow is the current `trigger_ticket_ai` owner.

For each of Claude, Codex, and the custom profile, it then:

1. enables only that canary workflow;
2. creates and dispatches an `[E2E]` Jira ticket;
3. waits for an authenticated run-detail response with `success`;
4. verifies the durable run pinned a definition version and captured the exact
   profile ID, profile version, provider, manifest hash metadata, and, for the
   custom case, exact GitHub skill provenance;
5. disables the canary workflow, moves the ticket out of AI, waits for its run
   reservation to clear, and deletes the ticket.

Finally it restores the original workflow trigger owner even after a test
failure. A process kill can prevent `finally` from running; in that case,
manually disable the canary fixture and re-enable
`HARNESS_CANARY_RESTORE_WORKFLOW_ID` before retrying.

Only after a complete `PASS` may the reviewed preview set
`NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED=1`. Enabling authoring is a
separate rollout change, not part of the canary command.
