---
paths:
  - "apps/worker/src/adapters/**"
  - "apps/worker/src/engine/agent-workflow.ts"
  - "apps/worker/src/engine/steps/clarification.ts"
  - "apps/worker/src/engine/steps/repository-promotion.ts"
  - "apps/worker/src/services/run-lifecycle/cancel-run.ts"
  - "apps/worker/src/memory/**"
  - "apps/worker/src/services/memory/**"
  - "apps/worker/src/engine/steps/memory-steps.ts"
  - "apps/worker/src/engine/steps/repo-memory-steps.ts"
  - "apps/worker/src/engine/steps/repo-seed-steps.ts"
---

# Issue tracker, VCS and messaging adapters

Messaging is a capability an integration serves since S9 (ADR-010). Core holds
only the port re-export (`adapters/messaging/types.ts`), the sender that
resolves the active provider per call (`engine/support/messaging.ts`) and the
`thread_parents` row that says which conversation a ticket owns
(`engine/support/messaging-conversation.ts`). The provider code lives in
`integrations/slack/**` and has its own tests.

Issue tracking is the same shape since S12. Core holds the port re-export
(`adapters/issue-tracker/types.ts`) and the resolution
(`engine/support/issue-tracker-runtime.ts`), and names no tracker. The Jira
client, its webhook and its health checks live in `integrations/jira/**` with
their own tests, including the ADF paragraph rule that used to be stated here.
Two consequences bind every edit under these paths:

- **A deployment may have no tracker at all.** `resolveActiveIssueTracker`
  answers a refusal with the sentence a person reads, and a caller either shows
  it or drops what it was going to show (a ticket link) rather than inventing
  an empty value that matches nothing.
- **The subject key has one derivation.** `ticketSubject(ticketKey)` in that
  same module is what dispatch, cancel, the watchdog, the reconciler, plan
  approval and the MCP tools all compare. Never spell `ticket:jira:<KEY>`
  anywhere else: a second spelling makes a live run invisible to whichever
  callers disagree.
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
Memory is a capability since S13, and the built-in store is one provider of it
(`memory/builtin/adapter.ts`), a core module because it needs core's database
(ADR-010 decision 10). Three things bind every edit under the memory paths:

- **Core speaks observations, never documents.** `activeMemory()`
  (`engine/support/memory-runtime.ts`) answers `recall` and `observe`; no
  caller outside `memory/builtin/**` may import `db/repositories/memory.ts`,
  parse or render a stored document, or hold a version. The one exception is
  routing memory in `engine/pre-sandbox/steps/repo-selection.ts`, which is not
  on the port and says so in the plan's "S13 scope not taken".
- **No provider is a legitimate state, and it is not a refusal.** Zero
  connected memory integrations means the built-in store, resolved before any
  pin comparison. Making `builtin` something an admin has to connect would
  stop memory at deploy on every deployment that has it switched on.
- **A refusal is reported, never swallowed.** `activeMemory()` never throws and
  answers a refusal instead; every caller records it (`unavailable` on the
  step's result, a `memory_unavailable` observation on the run where a hook is
  in scope) so a run that ran without memory is not indistinguishable from the
  first run on a subject. ADR-010 decisions 21 and 22.

- Branch creation is idempotent, not destructive. `createBranchIfMissing`
  returns `"existing"` for an already-existing ref. Only `resetOwnedBranch`
  resets a workflow-owned branch, and
  `apps/worker/src/engine/steps/repository-promotion.ts` first refuses a reset
  when the remote head differs from the ledger's published head. Guard:
  `apps/worker/src/engine/steps/repository-promotion.test.ts`.

History: docs/archive/agent-notes/packages-and-adapters.md
