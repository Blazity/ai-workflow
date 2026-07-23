# AI Workflow improvements: seven-PR implementation plan

Date: 2026-07-23

Product requirements and locked decisions are maintained in
[`2026-07-23-ai-workflow-improvements-decisions.md`](./2026-07-23-ai-workflow-improvements-decisions.md).
This document records the implementation order, compatibility boundaries,
migrations, and delivery gates for the stack.

## Delivery model

The work ships as a linear stack. Every child branch is based on the previous
PR until its parent merges. At most three PRs are marked ready for review at
once; later completed PRs may remain drafts until the ready window advances.

| PR | Branch | Jira | Migration |
| --- | --- | --- | --- |
| 1 | `codex/aiw-121-144-validation` | AIW-121, AIW-144 | none |
| 2 | `codex/aiw-119-v2-data-flow` | AIW-119, AIW-123, AIW-126 | none |
| 3 | `codex/aiw-120-v2-runtime` | AIW-120, AIW-131, AIW-132, AIW-133, AIW-140 | none |
| 4 | `codex/aiw-122-prompt-authoring` | AIW-122, AIW-124, AIW-125, AIW-129 | Prompt Slots |
| 5 | `codex/aiw-127-harness-profiles` | AIW-127, AIW-128, AIW-130 | profiles and skill artifacts |
| 6 | `codex/aiw-134-observability-replay` | AIW-134, AIW-135, AIW-136 | observations and attempts |
| 7 | `codex/aiw-137-editor-polish` | AIW-137, AIW-138, AIW-139 | none |

Tickets move to **In Progress** when their PR starts, **REVIEW** when the PR is
ready, and **Done** only after merge. Every PR is linked from all covered
tickets with its verification summary.

## Shared compatibility boundaries

- Workflow Definition v1 remains readable and executable through its existing
  interpreter. No definition or history is silently rewritten.
- Workflow Definition v2 introduces stable edge IDs, canonical `steps.`
  references, typed bindings, fan-out/fan-in semantics, and no execution-error
  ports.
- JSON Schema 2020-12 is the canonical structured-output contract. Provider
  schemas are boundary adaptations and returned values are revalidated against
  the canonical schema.
- Validation issues are structured errors with a code, optional node ID,
  optional field path, and actionable message.
- A block invocation carries immutable node, attempt, activation, cancellation,
  and observation context. The v2 runtime creates this seam and replay attaches
  persistence to it later.
- Only PRs 4, 5, and 6 add database migrations.

## PR 1: structured output and validation UX

- Centralize JSON Schema 2020-12 parsing, deployable-subset analysis,
  provider adaptation, value-schema derivation, and runtime validation.
- Support objects, arrays, strings, numbers, booleans, null, properties, items,
  required fields, descriptions, enums, nullable unions, and closed objects.
- Preserve unsupported raw schemas in drafts while reporting exact unsupported
  JSON Pointer paths and blocking deployment.
- Keep existing deployed v1 schemas executable through the compatibility path.
- Validate returned provider values before exposing them downstream; violations
  are Execution Failures.
- Run background validation after five idle seconds only when no block is
  selected. Save and Deploy validate the exact current snapshot immediately.
- Keep invalid drafts saveable. Deploy revalidates the exact stored version.
- Replace the in-flow amber banner with red node outlines, an expanded selected
  block error section, and a non-layout-shifting header popover.

## PR 2: Workflow Definition v2 and explicit data flow

- Add the `WorkflowDefinitionV1 | WorkflowDefinitionV2` contract without
  changing v1 serialization or execution.
- Add stable v2 control-edge IDs, multiple outgoing edges, typed reference or
  literal bindings, additional named input schemas, and no failure ports.
- Generate one worker-owned available-values catalog per consumer and reuse it
  for input, prompt, and Branch authoring.
- Determine availability from activation and join guarantees so unconditional
  parallel results are available at joins while conditional-only data is not.
- Add deterministic preview/apply migration and duplicate-as-v2 paths. Applied
  migration appends a draft and leaves deployment unchanged.
- Add declarative one-operation Transform blocks for object mapping and typed
  array filtering. Do not execute user-authored code.
- Keep v2 deployment disabled until PR 3 supplies the runtime.

## PR 3: v2 runtime and domain branching

- Preserve the v1 interpreter and add an event-driven v2 scheduler with
  active/inactive edge tokens, activation scopes, loop attempts, joins, and a
  four-block concurrency cap.
- Promote the first v2 execution failure to top-level workflow failure, cancel
  siblings, and retain a safe diagnostic ID.
- Reject unsafe concurrent workspace writer or writer/reader regions. Parallel
  reviews use disposable read-only workspaces.
- Replace v2 free-form Branch expressions with a typed Boolean condition AST.
- Keep negative Review and Check results as typed Domain Outcomes and provide
  visible editable Review/Check Branch templates.
- Run every authored check command in order. Nonzero exits are typed failures;
  infrastructure inability is an Execution Failure.
- Enforce passing Pre-PR checks against an unchanged workspace fingerprint in
  Finalize Workspace so a Branch cannot bypass publication safety.
- Reuse the merged review-ingestion foundation and add only v2 entry data,
  typed Fix/Review bindings, and safe diagnostic IDs.

## PR 4: prompt and schema authoring

- Add immutable Prompt Slot definitions to prompt-library versions.
- Persist canonical data, pinned prompt-version, and slot tokens while keeping
  legacy v1 tokens readable.
- Require every required slot to resolve from an available reference, literal,
  or valid default at deployment and immediately before execution.
- Keep Markdown as the one persisted prompt source and render references as
  lossless Tiptap chips.
- Provide lossless visual/raw structured-schema editing for the full deployable
  subset, preserving unsupported raw drafts.
- Use one effective-prompt compiler for preview and execution. Order Harness
  Profile instructions, repository instructions, the block role/task prompt,
  and clearly delimited runtime data; code invariants remain outside prompts.
- Introduce stable built-in compatibility profile IDs and switch new workflow
  authoring/templates to v2.

## PR 5: Harness Profiles and deterministic skills

- Add organization-scoped profile drafts, immutable versions, content-addressed
  skill artifacts/files, profile-skill references, and resolved run manifests.
- Seed persisted system profiles at the compatibility IDs introduced by PR 4.
- Keep v1 on a documented compatibility resolver; require exact profile
  references for new or edited v2 agents.
- Isolate runtime executables and home directories by profile-manifest hash,
  materialize only pinned files, and resolve credentials only at runtime.
- Restrict tools and MCP integrations to a code-owned catalog. Effective
  capabilities are the profile and block safety-envelope intersection.
- Add a skills.sh-like GitHub discovery/import/refresh flow using the
  organization's GitHub App and exact commit SHAs.
- Reject unsafe paths, symlinks, submodules, malformed skills, and artifacts
  over 500 files, 1 MiB per file, or 5 MiB total.
- Keep specialized agent blocks and their semantic contracts; expose profile,
  prompt, tools, limits, compaction, and subagent configuration without adding
  a separate preset entity.

## PR 6: sanitized attempts and visual replay

- Add per-run replay observations and per-block attempts tied to the exact
  Workflow Definition version.
- Remove historical output previews from summary status JSON; old runs show
  **Not captured** and are not backfilled.
- Capture a sanitized diagnostic copy without mutating execution data. Exclude
  auth/cookie/environment material and redact secrets, tokens, keys, credential
  URLs, contact information, and payment identifiers locally and
  deterministically.
- Apply 64 KiB input/output/log limits and a 256 KiB total attempt cap with
  explicit redaction/truncation metadata.
- Record triggers, retries, loops, parallel invocations, and clarification
  resumes as separate attempts through the PR 3 invocation context.
- Add authenticated paginated replay and attempt-detail APIs.
- Provide read-only live/completed visual replay with path, timing, attempts,
  Input, Output, Logs, and Metadata. Never rerun a step.
- Expire diagnostic observations after 30 days while retaining run history.

## PR 7: editor interactions and naming

- Add bounded transactional undo/redo for semantic and layout changes while
  preserving native text-editor history.
- Add multi-selection, keyboard deletion, right-click confirmation, protected
  required triggers, and session-scoped subgraph copy/paste with reference
  remapping.
- Persist adjustable edge curvature by stable edge ID in existing layout JSON.
- Make grid rendering follow canvas zoom/pan and highlight data provenance
  without drawing fake control edges.
- Produce `ai-workflow/` branches and `AI Workflow / ` checks while accepting
  both new and `blazebot` compatibility aliases.
- Do not rewrite history or rename `blazebot/memory`, the GitHub App, or Slack.

## Verification and completion

Each PR receives focused unit, component, integration, migration, and
orchestration coverage appropriate to its scope, followed by repository-wide
`pnpm test` and `pnpm typecheck`. Database PRs are tested from a fresh schema
and from the previous stack revision. User-facing PRs include screenshot or
recording evidence.

The implementation is complete when all seven branches are pushed, all seven
PRs exist with green verification and correct bases, every covered Jira ticket
links its PR, and the ready-for-review window is reconciled. Merge and
production deployment are separate actions.
