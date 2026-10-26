# Linear

The issue tracker this deployment watches: it finds the issues waiting in a
workflow state, reads and comments on them, moves them between workflow states,
and receives Linear's webhook when one changes.

## Connecting it

| Field | Variable | Required | What it is |
|---|---|---|---|
| API key | `LINEAR_API_TOKEN` | yes | A Personal API Key for the account that comments and moves issues. |
| Team key | `LINEAR_TEAM_KEY` | yes | The Linear team key whose issues this deployment watches, such as ENG. |
| Webhook secret | `LINEAR_WEBHOOK_SECRET` | only for webhooks | The signing secret Linear generates for its webhook. |
| Backlog state id | `LINEAR_BACKLOG_STATE_ID` | no | Target backlog column by workflow state UUID rather than status name. |
| AI column state id | `LINEAR_AI_STATE_ID` | no | Target AI column by workflow state UUID rather than status name. |
| AI Review state id | `LINEAR_AI_REVIEW_STATE_ID` | no | Target AI Review column by workflow state UUID rather than status name. |

An admin creates a Personal API Key in Linear under Settings > Security & Access
> Personal API keys. The token needs access to the configured team. The team key
is found in team settings or in the prefix of any issue key (for example, CUK in
CUK-16). The webhook secret is generated when creating a webhook under Settings >
API > Webhooks pointing to `https://<your-domain>/webhooks/linear`. Optional state
UUIDs can be inspected in Linear under Team Settings > Workflow.

An admin can set the environment variables on the deployment, or type the values
on the Integrations page, where saving tests them before they are used.

## What connecting it unlocks

- The **issue_tracker** capability: reads issues, comments, acceptance criteria,
  attachments, and relations, moves issues between workflow states, and posts
  progress comments with run markers.
- Webhook dispatch from Linear: listens for issue and comment events at
  `/webhooks/linear` to start runs, resume from clarification answers, or cancel
  runs.
- Three health checks on the System Health page: Account access (verifying API key
  validity and the viewer account), Team access (confirming team presence and
  available workflow states), and Webhook registration (confirming an active
  webhook pointing to this deployment).

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, connection fields, capabilities, health checks. Plain data. |
| `issue-tracker.ts` | The `issue_tracker` capability using Linear's GraphQL API over `ctx.http.fetch`. |
| `query-rule.ts` | Validates queries authored for this tracker. Linear does not use JQL, so it guides authors to leave the query blank and rely on keywords. |
| `webhook.ts` | Verifies the `Linear-Signature` header and extracts issue events. Core handles dispatch, cancellation, clarification and approval. |
| `worker.ts` | Connection test, capability factory and the three health checks (Account access, Team access, Webhook registration). |
| `test-fixtures/` | Recorded Linear GraphQL and webhook payloads, each with its source URL, retrieval date and SHA-256 digest beside it. |

The integration id is exactly `linear` and it is permanent: it is written into
`ticket:linear:<IDENTIFIER>` on every run row that follows an issue, and renaming
it would be a migration over run history rather than a rename.

## Provider documentation this is written against

| What | Where | Read on |
|---|---|---|
| Authentication and Personal API keys | `https://linear.app/developers/graphql` | 2026-10-21 |
| GraphQL Schema, queries, mutations and filters | `https://linear.app/developers/graphql` | 2026-10-21 |
| Webhook delivery, headers and HMAC-SHA256 signature | `https://linear.app/docs/webhooks` | 2026-10-21 |
| Pagination, rate limits and error codes | `https://linear.app/developers/graphql` | 2026-10-21 |
