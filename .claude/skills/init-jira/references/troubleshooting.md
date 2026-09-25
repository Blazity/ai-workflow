# Jira troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never picks up a ticket | Jira status differs from the AI column setting | Run the `/statuses` curl from `column-statuses.md` and reconcile. |
| `No transition to "AI Review" found` | No transition from the current status has that name or lands in a status of that name | Add or retarget the transition, or set its id. See `transitions.md`. |
| `401 The signature did not match.` | Secret mismatch | Re-copy `JIRA_WEBHOOK_SECRET` to both Vercel env and Jira webhook config. |
| Agent produces empty AC | Description has no `Acceptance Criteria:` block | Edit ticket description. See `description-format.md`. |
| 403 on transition | Permission scheme blocks bot account | Grant `Transition issues` to the bot's role. |
| 400 on transition with `errorMessages: ["Resolution required"]` | Transition has a validator | Disable validator or pre-set Resolution via Automation. |

## Lock down the API token

Atlassian service-account tokens are bearer credentials: anyone holding the token can act as the service account.

- **Use a dedicated bot account**, not a human's, so revocation doesn't lock anyone out.
- **Rotate quarterly** (admin.atlassian.com, Directory, Service accounts, API tokens: revoke and recreate; then update the env and redeploy, or paste it on Integrations → Jira → Connection).
- **Restrict the bot account's project access** to just the AI Workflow project (Project settings → People → remove from other projects).
- **Audit comments**: every AI-driven comment is authored by the bot account, so they are easy to filter in Jira's activity view by user.

Atlassian OAuth 2.0 (3LO) is not supported: the client (`integrations/jira/issue-tracker.ts`) sends the service-account token as Bearer through api.atlassian.com.
