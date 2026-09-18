---
paths:
  - "apps/worker/src/adapters/**"
---

# Issue tracker, VCS and messaging adapters

- Jira REST v3 comments require ADF, and ADF text nodes cannot contain `\n`.
  Multi-line content must be modelled as multiple paragraph nodes (or
  `hardBreak` inline nodes). Newline-joined text in a single text node returns
  400 on `/rest/api/3/issue/{id}/comment`. Use the adapter helper
  `toAdfParagraphs`.
- The chat package's `ChatConfig` requires both `state: StateAdapter` and
  `userName: string`. No no-op state adapter is exported, so an outbound-only
  use case still has to implement the interface.
  `createSlackAdapter` takes `botToken`, not `token`.
- The bot has exactly one Jira comment path for ASKING a clarification
  (`postClarificationQuestionsCommentStep`, `engine/steps/clarification.ts`);
  failures notify Slack and post no comment.
  Anything that infers "awaiting input" from ticket state depends on that
  invariant.
- Closing one is a second path, and only that: cancelling a run that published a
  question posts one comment saying the question is no longer open and removes
  the `needs-clarification` label (`services/run-lifecycle/cancel-run.ts`). It is
  best effort, it is guarded to fire once per run by the clarification row it
  consumes plus a marker in the comment, and it never posts for a run that asked
  nothing. So ticket state stays readable: the label is on while a question is
  open and gone once it is closed, whichever way it closed.
