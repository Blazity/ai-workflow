# Transitions: the second silent failure

Single most-missed step in Jira setup. `findTransition` (`integrations/jira/issue-tracker.ts`) picks the transition in this order:

1. the configured transition id, when set (`JIRA_AI_TRANSITION_ID`, `JIRA_AI_REVIEW_TRANSITION_ID`, `JIRA_BACKLOG_TRANSITION_ID`, or the same fields on Integrations → Jira → Connection);
2. otherwise a transition whose destination status id matches the target status;
3. otherwise a transition whose **name** equals the target column name, ignoring case;
4. otherwise a transition whose destination status **name** equals it, ignoring case.

Setting the three transition ids is the robust path, especially when Jira localizes names. Without them, a transition matches when its name or the name of the status it lands in equals the AI, AI Review or Backlog column setting on the Settings page, so `Move to AI Review` landing in `AI Review` works.

## Required transitions

| From | To | Transition name | Triggered by |
|------|-----|-----------------|--------------|
| `Backlog` (or any) | `AI` | `AI` | Human (drags ticket to start agent) |
| `AI` | `AI Review` | `AI Review` | AI Workflow (agent finished, PR pushed) |
| `AI` | `Backlog` | `Backlog` | AI Workflow (agent needs clarification) |
| `AI Review` | `Backlog` or `AI` | n/a | Human (re-loop after review) |

The "Human" rows only need to exist in the UI; the bot does not trigger them. The "AI Workflow" rows must exist and land in the status the column setting names; their own name then does not matter.

## Edit the workflow

**Team-managed:** Project settings → Workflow → click the arrow between two statuses → rename via the field at the top of the side panel. Save.

**Company-managed:** Project settings → Workflows → Edit (or Jira Settings → Workflows for shared workflows). Switch to **Diagram** view → click the transition arrow → rename → **Publish Draft**.

If the source status doesn't have an outbound transition to the target, draw a new one first, then rename it.

## Verify transitions are present

For an issue currently in `AI`:

```bash
CLOUD_ID=$(curl -s "$JIRA_BASE_URL/_edge/tenant_info" | jq -r .cloudId)
curl -H "Authorization: Bearer $JIRA_API_TOKEN" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/$JIRA_PROJECT_KEY-1/transitions" | \
  jq '.transitions[] | {name, to: .to.name}'
```

You should see a transition whose `name` or `to` is `AI Review`, and one for `Backlog`. When none matches, the bot fails with `No transition to "AI Review" found for issue …` and lists the transitions it saw: add or retarget the transition, or set its id.

## Common workflow pitfalls

- **Transition has conditions** (e.g. "only assignee can transition"): AI Workflow's account will be blocked. Remove the condition, or assign every ticket to the bot account before the AI status.
- **Transition has a screen** (post-function asking for input): the API call succeeds but the screen pops for the next human; harmless. Remove the screen if you want clean tickets.
- **Validators on transition** (e.g. "resolution required"): API call fails 400. Disable the validator or pre-populate the field via Automation.
