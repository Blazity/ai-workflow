---
paths:
  - "apps/worker/src/adapters/**"
  - "apps/worker/src/engine/agent-workflow.ts"
  - "apps/worker/src/engine/steps/clarification.ts"
  - "apps/worker/src/engine/steps/repository-promotion.ts"
  - "apps/worker/src/services/run-lifecycle/cancel-run.ts"
---

# Issue tracker, VCS and messaging adapters

Messaging is a capability an integration serves since S9 (ADR-010). Core holds
only the port re-export (`adapters/messaging/types.ts`), the sender that
resolves the active provider per call (`engine/support/messaging.ts`) and the
`thread_parents` row that says which conversation a ticket owns
(`engine/support/messaging-conversation.ts`). The provider code lives in
`integrations/slack/**` and has its own tests.

- Build Jira REST v3 comments as ADF through `toAdfParagraphs`. It splits LF or
  CRLF input into paragraph nodes and never places a newline inside an ADF text
  node. Guard: `apps/worker/src/adapters/issue-tracker/jira.test.ts`.
- A notification never changes a run. `MessagingSender` answers
  `MessagingDelivery` and does not throw, whatever the provider does; the
  `send_message` block reads that answer and reports `skipped` with the reason,
  and every other caller ignores it and lets the warning in the log be the
  record.
- Clarification questions have one Jira posting step:
  `postClarificationQuestionsCommentStep`. It returns null after a non-control
  posting failure, and the workflow still sends the
  `needs_clarification` notification without `commentUrl`. Awaiting state is stored in
  the database; `parkForClarificationStep` only applies the ticket label and
  move.
- Closing a question is the second path and only that: cancelling a run that
  published one posts a comment saying the question is no longer open and
  removes the `needs-clarification` label
  (`apps/worker/src/services/run-lifecycle/cancel-run.ts`). It is best effort,
  guarded to fire once per run, and never posts for a run that asked nothing,
  so the label is on while a question is open and gone once it closed, whichever
  way it closed.
- Branch creation is idempotent, not destructive. `createBranchIfMissing`
  returns `"existing"` for an already-existing ref. Only `resetOwnedBranch`
  resets a workflow-owned branch, and
  `apps/worker/src/engine/steps/repository-promotion.ts` first refuses a reset
  when the remote head differs from the ledger's published head. Guard:
  `apps/worker/src/engine/steps/repository-promotion.test.ts`.

History: docs/archive/agent-notes/packages-and-adapters.md
