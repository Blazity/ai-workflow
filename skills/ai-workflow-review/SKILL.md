---
name: ai-workflow-review
description: Review rules for the ai-workflow repository itself, covering the Vercel Workflow runtime, the Neon driver, the block catalog mirror, migration numbering and the hashes that pin harness profiles. Use when reviewing a pull request in ai-workflow, ai-workflow-demo or ai-workflow-prod.
---

## Scope

This skill covers pull requests in the `ai-workflow` monorepo and its deployment
clones. The traps below are specific to this codebase: each one shipped a real
defect that unit tests did not catch, so they are worth a comment even when the
diff looks ordinary.

## Severity anchors

Both `Blocker` and `High` block the merge, so the calibration that carries
information is the line between `High` and `Medium`.

| Class of defect | Level |
|---|---|
| A change that rehashes stored artifacts or unpins deployed profiles | Blocker |
| A migration that cannot be rolled back, or a migration number already taken | Blocker |
| A secret, token or customer identifier in the diff | Blocker |
| A runtime failure that only appears on the deployed platform | High |
| A failure path that reaches the user as silence | High |
| A contract this guide documents, broken | High |
| A deviation from a documented convention, with consequences | Medium |
| New logic with no test | Medium |
| Naming, formatting, wording | Nit |

A finding you cannot place in this table is a `Medium`.

## Comment discipline

Emit at most 10 comments, of which at most 3 may be `Blocker` or `High`. Anchor
every comment to a file and line. Only the diff's additions are the author's
responsibility: a pre-existing violation may be cited as "do not copy this
pattern", never filed as a defect of this change. Reporting no findings is a
valid and expected outcome.

## 1. Node built-ins outside a step break only the deployed build

Workflow code compiled by the Vercel Workflow DevKit may not reach Node built-ins
outside a function marked `"use step"`. A logger, `node:fs`, `node:crypto` or a
transitive import that pulls one in compiles locally, passes vitest and passes a
local nitro build, then fails the Vercel build alone.

`[High]` Detect: an import of a Node built-in, or of a module that wraps one,
added at the top level of a file under `apps/worker/src/workflows/`. The fix is
to move the call inside the step that needs it.

## 2. The Neon HTTP driver has no transactions

Production runs the worker against `neon-http`, which rejects `db.transaction()`
at runtime. Tests run against pglite, which accepts it, so this passes every
local gate and 500s on the deployed worker.

`[High]` Detect: `db.transaction(` added anywhere in a worker write path. The
sanctioned shape is a single statement, usually a CTE chain, so that the write is
atomic without a transaction.

## 3. The block catalog is mirrored by hand

Adding or changing a workflow block type means editing both the registry and the
catalog mirror in `docs/workflow-workspace/index.html`. A gate test compares the
two, including the block count and the exact parameter lists.

`[Medium]` Detect: a change to `apps/worker/src/workflow-definition/block-registry.ts`
or to `BLOCK_PARAM_KEYS` with no matching change to the mirror. Statuses must
appear in registry order, not alphabetically.

## 4. Migration numbers collide between parallel branches

Every open branch generates the next number against `main`, so two branches
routinely claim the same one. The journal then disagrees with the files and
migrations apply in an order nobody chose.

`[Blocker]` Detect: a new file under `apps/worker/drizzle/` whose number also
appears on another open pull request. Check the open pull requests, not only
`main`. The branch that opened later renumbers, and regenerates its journal entry
and snapshot rather than editing them by hand.

`[High]` A migration with no prose header. Sibling migrations state what the
change is for and what reverting it costs; a bare `ALTER TABLE` does not.

## 5. Hashes pin things that are already deployed

`artifactHash` covers a skill's source, name, description and files, and harness
profiles pin skills by it. The profile manifest is hashed too. Adding a field to
either object rehashes everything already stored and unpins every profile that
points at it, which fails every run carrying a pinned skill.

`[Blocker]` Detect: a new field inside a hashed payload, in
`apps/shared/contracts/harness-profiles.ts` or in `canonicalHashPayload`. Data
that only the dashboard needs belongs in a field derived at read time.

## 6. Built-in prompts are frozen in a migration

Editing `apps/shared/contracts/default-prompts.ts` alone changes nothing for a
deployed run: the prompt bodies live in a migration seed, and a drift gate fails
when the two disagree.

`[High]` Detect: a change to a built-in prompt with no accompanying resync
migration. A prompt that belongs to one customer's workflow belongs in that
workflow's block configuration instead, where no migration applies.

## 7. A workflow value that only exists inside a run

Replay reconstructs a run from recorded results. A value computed outside a step,
or read from wall-clock time, differs between the first pass and the replay, and
the divergence surfaces as a discarded run rather than as a clear error.

`[High]` Detect: `Date.now()`, `Math.random()` or a fresh UUID added to workflow
scope rather than inside a step.

## 8. Silence is not a result

A failure path that neither throws nor records leaves the run reporting success.
This repository has shipped several: a stranded pull-request check, a review
published twice for one head, a region executed twice.

`[High]` Detect: a caught error with an empty handler, a `continue` past a
failure with no record, or a status set optimistically before the operation that
justifies it.

## 9. House style

`[Nit]` No em dashes or en dashes in code, comments, UI copy or commit messages.
A comma, colon, period or parenthesis instead.

`[Nit]` Commits are a single conventional line, no body and no footer, with the
ticket key in the subject.
