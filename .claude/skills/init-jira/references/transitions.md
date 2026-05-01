# Transitions — the second silent failure

Single most-missed step in Jira setup. The adapter at `src/adapters/issue-tracker/jira.ts:86` finds a transition by **transition name** equal to the target column name:

```ts
data.transitions.find(t => t.name.toLowerCase() === column.toLowerCase())
```

So your workflow must have transitions whose **names** are exactly `AI`, `AI Review`, and `Backlog` (or whatever you renamed `COLUMN_*` to).

## Required transitions

| From | To | Transition name | Triggered by |
|------|-----|-----------------|--------------|
| `Backlog` (or any) | `AI` | `AI` | Human (drags ticket to start agent) |
| `AI` | `AI Review` | `AI Review` | Blazebot (agent finished, PR pushed) |
| `AI` | `Backlog` | `Backlog` | Blazebot (agent needs clarification) |
| `AI Review` | `Backlog` or `AI` | n/a | Human (re-loop after review) |

The "Human" rows just need to exist in the UI — the bot doesn't trigger them. The "Blazebot" rows must exist **and** be named exactly per the table. Rename existing transitions if needed.

## Edit the workflow

**Team-managed:** Project settings → Workflow → click the arrow between two statuses → rename via the field at the top of the side panel. Save.

**Company-managed:** Project settings → Workflows → Edit (or Jira Settings → Workflows for shared workflows). Switch to **Diagram** view → click the transition arrow → rename → **Publish Draft**.

If the source status doesn't have an outbound transition to the target, draw a new one first, then rename it.

## Verify transitions are present

For an issue currently in `AI`:

```bash
curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$JIRA_PROJECT_KEY-1/transitions" | \
  jq '.transitions[] | {name, to: .to.name}'
```

You should see entries with `"name": "AI Review"` (to → `AI Review`) and `"name": "Backlog"` (to → `Backlog`). If a transition's `name` is something like `"Move to AI Review"`, the bot fails with `No transition to "AI Review" found for issue …`. Rename to fix.

## Common workflow pitfalls

- **Transition has conditions** (e.g. "only assignee can transition") — Blazebot's account will be blocked. Remove the condition, or assign every ticket to the bot account before the AI status.
- **Transition has a screen** (post-function asking for input) — the API call succeeds but the screen pops for the next human; harmless. Remove the screen if you want clean tickets.
- **Validators on transition** (e.g. "resolution required") — API call fails 400. Disable the validator or pre-populate the field via Automation.
