---
paths:
  - "apps/worker/src/adapters/**"
  - "apps/worker/src/engine/agent-workflow.ts"
  - "apps/worker/src/engine/steps/clarification.ts"
  - "apps/worker/src/engine/steps/repository-promotion.ts"
  - "apps/worker/src/services/run-lifecycle/cancel-run.ts"
---

# Issue tracker, VCS and messaging adapters

- Build Jira REST v3 comments as ADF through `toAdfParagraphs`. It splits LF or
  CRLF input into paragraph nodes and never places a newline inside an ADF text
  node. Guard: `apps/worker/src/adapters/issue-tracker/jira.test.ts`.
- Preserve the outbound chat construction in
  `apps/worker/src/adapters/messaging/chatsdk.ts`: `new Chat` receives
  `userName` and `state: noopState`, while `createSlackAdapter` receives
  `botToken`.
- Clarification questions have one Jira posting step:
  `postClarificationQuestionsCommentStep`. It returns null after a non-control
  posting failure, and the workflow still sends the Slack
  `needs_clarification` event without `commentUrl`. Awaiting state is stored in
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
