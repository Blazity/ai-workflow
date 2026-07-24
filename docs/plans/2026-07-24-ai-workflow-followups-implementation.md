# AI Workflow follow-up batch

## Delivery stack

Implement the locked follow-up specification as three linear PRs. Use clean
worktrees based on the latest stack parent and do not modify the dirty primary
checkout.

| PR | Branch | Jira tickets | Base |
| --- | --- | --- | --- |
| 1 | `codex/aiw-followups-validation-hardening` | AIW-148, AIW-149, AIW-158, AIW-159, AIW-160, AIW-162, AIW-163, AIW-167, AIW-169, AIW-171, AIW-176 | `main` |
| 2 | `codex/aiw-followups-data-picker-editor` | AIW-150, AIW-154, AIW-155, AIW-157, AIW-161, AIW-164, AIW-165, AIW-166, AIW-168, AIW-170 | PR 1 |
| 3 | `codex/aiw-followups-branch-transform` | AIW-152, AIW-153 | PR 2 |

AIW-172 is the final manual acceptance gate after the stack merges. There are
no database migrations. Workflow Definition v1 stays compatible; undeployed v2
contracts may change without a compatibility UI.

## PR 1: validation and runtime hardening

- Bind validation results to the exact semantic snapshot. Semantic changes
  dismiss stale results; layout changes do not.
- Background validation waits five idle seconds and pauses while a block is
  focused. The waiting period has no validation badge. `Checking…` appears only
  while a request is running.
- A Save response is authoritative for the exact snapshot it persisted. Remove
  duplicate pre-validation, advance the saved baseline even if later edits
  exist, and never display the saved snapshot's issues as current after a newer
  edit.
- Deploy owns its immediate validation. Background validation cannot supersede
  it. A semantic edit aborts the deployment attempt and asks the user to deploy
  again; cancelled requests never become Validation Issues.
- Make validation controller creation and disposal safe under React Strict
  Mode.
- Centralize workflow-definition validation-to-422 responses, resolve Harness
  Profiles once, share effective-prompt versus fallback input assembly, prevent
  duplicate prompt-slot errors, bound repository instruction reads while
  streaming, and make agent replay observations best-effort.
- Align GitLab documentation with the separate trusted publisher and exact
  force-with-lease behavior. Fix managed check-prefix Markdown without changing
  compatibility semantics.

## PR 2: catalog, picker, and editor foundations

Add whole-output v2 references:

```ts
type WorkflowDataReferenceV2 =
  | "steps.entry.output"
  | `steps.entry.output.${string}`
  | `steps.${string}.output`
  | `steps.${string}.output.${string}`
  | `run.${string}`;
```

Add an authenticated, organization-scoped, `no-store` candidate catalog:

```http
POST /api/v1/workflow-definitions/:id/catalog

{ "definition": WorkflowDefinitionV2 }
```

The worker returns node contracts plus available and unavailable values for
each consumer. Entries include the canonical reference, friendly metadata,
schema, presence, source, compatibility, and an authoritative availability
reason. Explicit schema/default/literal examples are allowed; run data is not.

- Refresh the catalog immediately after contract-affecting edits, separately
  from delayed validation. Keep the picker open and preserve its state while
  refreshing, disable stale choices, and let only the latest fingerprint win.
- Use one shared picker for ordinary mappings, text insertion, Branch, and
  Transform. It has only Previous steps and Run info tabs, with search, nested
  fields, readable chips, and a collapsed Unavailable section. Raw references,
  Trigger Data, and Outcomes are absent.
- `steps.entry` is the actual active trigger. Multi-trigger consumers see
  `Trigger that started this run`, common fields, the whole payload, and
  `run.trigger.id`/`type`. Trigger-specific fields stay unavailable until
  control flow guarantees the trigger. Manual dispatch uses the same contract.
- Add one plain-text Tiptap template editor with atomic data chips and canonical
  `{{data:...}}` serialization. Reuse it for Format text and v2 prose/message
  inputs.
- Replace the centered delete confirmation with a pointer context menu.
  Context-menu and keyboard deletion use the same undoable transaction.
  Deleting the final trigger is allowed in a saveable draft but blocks
  deployment.
- Complete the prompt-drop, schema-focus, drag target, Escape handling, edge
  tangent, and whole-reference token-boundary follow-ups.

## PR 3: Branch and Transform

Replace v2 Branch with a flat condition list joined globally by `all` or `any`.
Conditions select one left reference, a type-safe operator, and an authored
literal. Presence checks treat missing and null as no value. Text comparisons
may ignore capitalization; numbers never coerce. Keep True and False ports.
Remove generic inputs, raw schemas, nested groups, dynamic right-hand values,
and Outcomes.

Replace v2 Transform with exactly one of:

- Format text
- Trim text
- Replace text
- Text to number
- Number to text
- Parse JSON
- Build object

Sources come directly from the shared picker. Format text returns a string.
Trim removes both outer ends. Replace supports plain text or safe RE2 regex,
all matches, fixed literal replacement, and optional case-insensitive matching.
Text to number and Parse JSON return stable
`{ success, value, error }` domain results. Number to text is finite,
locale-independent conversion. Build object creates one flat object with safe,
unique field names and scalar authored literals/defaults.

Transform always displays its derived output shape and previews only results
calculable entirely from authored values. It never fabricates examples or reads
previous runs.

Update v2 fixtures, templates, migration output, duplication, clipboard
visitors, reference parsing, catalog analysis, and runtime execution to the new
contracts. Preserve all v1 behavior.

## Verification and Jira

- Run focused unit, component, integration, and orchestration tests for each PR,
  followed by repository-wide `pnpm test` and `pnpm typecheck`.
- Move each PR's tickets to In Progress when work starts and Review only after
  the PR is complete and green. Add the PR URL and exact verification to every
  covered ticket. Move tickets to Done only after merge.
- Do not perform browser QA. Leave the final dashboard and worker running for
  the user's manual review.
- Refresh AIW-172 and the local checklist site to replace old Map/Filter and
  Branch expectations while retaining all other unverified original-stack
  checks. New acceptance bugs become separate Jira follow-ups.
