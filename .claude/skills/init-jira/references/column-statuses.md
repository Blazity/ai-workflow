# Column statuses — the most common silent failure

Blazebot polls Jira with this JQL every minute:

```jql
project = "$JIRA_PROJECT_KEY" AND status = "$COLUMN_AI"
```

That means **`COLUMN_AI`, `COLUMN_AI_REVIEW`, and `COLUMN_BACKLOG` must be Jira *status* names, exact case-insensitive match — not just board column labels.** A board column whose underlying status differs will silently never match.

## Defaults

| Env var | Status name | Purpose |
|---|---|---|
| `COLUMN_AI` | `AI` | Tickets in this status get picked up by the agent |
| `COLUMN_AI_REVIEW` | `AI Review` | Tickets the agent has finished and pushed a PR for |
| `COLUMN_BACKLOG` | `Backlog` | Where the agent parks tickets needing clarification |

You can rename these — just keep Vercel env in sync.

## Create or rename the three statuses

**Team-managed project:** Project settings → Board → Columns. Click **Add status** or rename inline. Each board column maps 1:1 to a status by default.

**Company-managed project:** statuses live globally. Jira Settings → Issues → Statuses. Create the three names (or reuse existing — `Backlog` usually exists). Then in Project settings → Workflows, edit the workflow used by your issue type and add the new statuses.

## Map them to board columns

Open the board → **... → Configure board → Columns**:

```
┌──────────┬────────┬───────────┬──────────┐
│ Backlog  │   AI   │ AI Review │   Done   │
└──────────┴────────┴───────────┴──────────┘
```

Each column should contain exactly one status with the matching name. Don't put `AI` and `In Progress` in the same column — Blazebot's JQL hits status, not column, but humans seeing the board will be confused.

## Verify the status spelling

```bash
CLOUD_ID=$(curl -s "$JIRA_BASE_URL/_edge/tenant_info" | jq -r .cloudId)
curl -H "Authorization: Bearer $JIRA_API_TOKEN" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/project/$JIRA_PROJECT_KEY/statuses" | \
  jq '.[].statuses[].name'
```

Output must include the exact strings used in `COLUMN_AI` / `COLUMN_AI_REVIEW` / `COLUMN_BACKLOG` (case-insensitive). Trailing spaces in either side will silently break JQL — strip them.
