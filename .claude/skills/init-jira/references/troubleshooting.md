# Jira troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never picks up a ticket | Status name ≠ `COLUMN_AI` env value | Run the `/statuses` curl from `column-statuses.md` and reconcile. |
| `No transition to "AI Review" found` | Transition name in workflow is e.g. `Move to AI Review` | Rename transition. See `transitions.md`. |
| `401 Invalid webhook signature` | Secret mismatch | Re-copy `JIRA_WEBHOOK_SECRET` to both Vercel env and Jira webhook config. |
| Agent produces empty AC | Description has no `Acceptance Criteria:` block | Edit ticket description. See `description-format.md`. |
| 403 on transition | Permission scheme blocks bot account | Grant `Transition issues` to the bot's role. |
| 400 on transition with `errorMessages: ["Resolution required"]` | Transition has a validator | Disable validator or pre-set Resolution via Automation. |
| Ticket stuck in `AI` after PR exists | Reconcile thinks run is orphaned | Check Vercel logs for `reconcile_orphan_run`; usually self-heals on next cron tick. |

## Lock down the API token

Atlassian tokens are bearer credentials — anyone holding token + email can act as the user.

- **Use a dedicated bot account**, not a human's, so revocation doesn't lock anyone out.
- **Rotate quarterly** (`/manage-profile/security/api-tokens` → revoke + recreate; redeploy with new env).
- **Restrict the bot account's project access** to just the Blazebot project (Project settings → People → remove from other projects).
- **Audit comments**: every AI-driven comment is authored by the bot account — easy to filter in Jira's activity view by user.

For higher-trust setups, switch to Atlassian OAuth 2.0 (3LO) — but that's not currently supported by `src/adapters/issue-tracker/jira.ts` (uses Basic auth).
