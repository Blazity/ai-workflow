# Jira

The issue tracker this deployment watches: it finds the tickets waiting in a
column, reads and comments on them, moves them between statuses, and receives
Jira's webhook when one changes.

- `manifest.ts` is what core may know without running any of this code.
- `issue-tracker.ts` implements the `issue_tracker` capability. `adf-text.ts`
  is how a description or a comment in Jira's rich text becomes the plain text
  every agent and every answer reader gets.
- `webhook.ts` verifies a delivery and says what happened to a ticket. It
  decides nothing about runs: dispatch, cancellation, clarification and plan
  approval are core's, and they are the same for the next tracker.
- `worker.ts` is the runtime: the connection test, the capability factory and
  the three health checks (Account access, Project access, Webhook
  registration). Project access is where core's old Jira probe went: a project
  key that names nothing boots fine (it always did, the old variables only had
  to be present) and reads Down here with the value to fix.
- `test-fixtures/` holds recorded Jira deliveries, each with its source URL,
  its retrieval date and its SHA-256 beside it.

The integration id is exactly `jira` and it is permanent: it is written into
`ticket:jira:<KEY>` on every run row that follows a ticket, and renaming it
would be a migration over run history rather than a rename.
