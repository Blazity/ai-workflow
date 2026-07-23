# AI Workflow improvements: product specification and decision record

Date: 2026-07-23

Source backlog: `/Users/karol/Downloads/AI workflow improvements.md`

This is the persistent source of truth for the product requirements and decisions covering AIW-119 through AIW-140 plus requirements added during clarification. It consolidates the original 22-item backlog with the full clarification transcript from this task. Update it immediately when a decision changes.

This document is **not an implementation plan**. It intentionally does not define PR boundaries, migration contents, file changes, or implementation order. Those will be written only after the user explicitly asks for the implementation plan.

## Transcript audit

The complete pre-compaction task transcript was re-read on 2026-07-23 and checked against this document. It contains three substantive decision rounds:

1. the initial audit of all 22 backlog items against Jira and merged `main`;
2. the user's answers to the 11 initial clarification questions; and
3. the follow-up answers covering the `steps.` namespace, JSON Schema 2020-12, Transform isolation, profile defaults/forking, and execution-failure branching.

The original audit used merged `main` at `f121b16`. At that snapshot, all 22 backlog candidates existed one-for-one as AIW-119 through AIW-140 under AIW-118 and were in To Do. No Jira status was changed during specification work.

The audit corrected the earlier record in these ways:

- restored acceptance details for explicit inputs, checks, redaction, attempts, editor history, canvas behavior, naming, and review-comment ingestion;
- retained the distinction between a locked requirement, a recommendation, and an unresolved product decision;
- recorded and then locked the shared source catalog for prompt and workflow data references;
- recorded and then resolved the question of a separate persisted “preset” concept;
- recorded the later decision to use a finite declarative Transform instead of executing user-authored code;
- recorded and then resolved the initial Transform operation set and profile-default behavior;
- removed the provisional PR grouping from the specification; and
- preserved the user's instruction that the implementation plan must wait for an explicit call.

## Status vocabulary

- **Locked**: agreed product or implementation constraint.
- **Recommended, needs verification**: preferred direction, but a spike or compatibility check must pass before it becomes locked.
- **Open**: requires an explicit product decision.

## Locked decisions

### Delivery and Jira hygiene

- Plan against the latest merged `main`, not only the original backlog text.
- Do not reimplement work that is already on `main`. Close a duplicate ticket or reduce it to the remaining delta, with evidence linking the existing implementation.
- When implementation is authorized, deliver this work as a small stack of coherent PRs rather than one large PR or dozens of one-ticket PRs.
- Consolidate database changes so the stack does not create a migration for every individual ticket.
- Move a Jira ticket to **In Progress** when implementation of its group starts, **REVIEW** when its PR is ready for review, and **Done** only after merge. Tickets delivered by one PR move together.

### Workflow Definition v2 and compatibility

- Workflow Definition v1 remains readable and executable.
- Incompatible semantics are introduced through an explicit v2 migration or duplication action.
- Migration creates a new workflow-definition version and never mutates a deployed definition in place.
- Lossy or unsupported conversions are reported before migration.
- Migration never silently removes a connection or block configuration.
- Previous workflow-definition versions and their run histories remain accessible.

### Control flow, data flow, and references

- Arrows represent control flow only. Data bindings are explicit.
- Canonical data references keep the `steps.` namespace:
  - entry data: `steps.entry.output.<path>`
  - step data: `steps.<step-id>.output.<path>`
  - run metadata: `run.<field>`
- Raw reference strings are an internal representation. The normal editor presents block/field pickers and readable reference chips.
- Legacy `trigger.*` references remain readable and can be migrated.
- Existing flat prompt tokens such as `{{ticket_title}}` remain readable and migratable, but new Workflow Definition v2 authoring stores canonical data references rather than creating more magic global variables.
- `steps.entry` identifies the trigger that activated the run, including when several triggers can enter shared downstream blocks.
- Reference autocomplete only offers values available at the current block.
- References must resolve to data available on every valid incoming path. Missing, mistyped, type-incompatible, or unreachable references block deployment.
- Selecting a reference identifies its source block and schema; selecting it on the canvas can highlight its data source.
- Typed input binding and prompt-variable insertion use one canonical available-values catalog generated for the consuming block.
- The catalog contains `steps.entry.output.*`, guaranteed upstream `steps.<step-id>.output.*`, and `run.*` values. Each entry carries its stable internal path, friendly label, description, schema/type, source, and availability provenance.
- Each editor filters the shared catalog to values valid in its context. The typed input picker also filters by assignable type.
- Prompt insertion stores a reference token and presents it as a readable chip; it does not copy the value or maintain an unrelated flat variable catalog.
- Prompt-library references remain a separate reference kind because they identify reusable prompt content rather than runtime data.
- A reusable prompt can expose named Prompt Slots such as `plan`. When a block uses that prompt, its slots appear as explicit values that the block must provide.
- Prompt Slots are required by default. A prompt author can explicitly mark a slot optional or provide a default value.
- A Prompt Slot can be filled with an available workflow value, an allowed literal value, or an authored default.
- The editor reports a block-level Validation Issue when a required Prompt Slot has no value, refers to unavailable data, or is otherwise invalid. Missing, `null`, and whitespace-only text count as unfilled for a required text slot.
- Required Prompt Slots are checked again immediately before execution. An agent block never runs with an unresolved slot or a raw placeholder accidentally left in its effective prompt.
- Fan-out activates downstream branches concurrently.
- One control output can connect to more than one downstream block.
- Fan-in waits for every activated predecessor. An inactive conditional branch does not block the join.
- Initial parallel review agents are read-only. Unsafe concurrent writers are rejected.

### Structured outputs

- JSON Schema 2020-12 is the canonical internal representation for structured outputs.
- The initially deployable subset supports:
  - `object`, `array`, `string`, `number`, `boolean`, and `null`;
  - `properties`, `items`, `required`, descriptions, enums, and nullable type unions; and
  - closed objects with `additionalProperties: false`.
- `$ref`/`$defs`, `anyOf`/`oneOf`/`allOf`, conditionals, tuples, patterns/formats, numeric/string/array constraints, schema-valued `additionalProperties`, and provider-specific keywords are not initially deployable.
- Provider adapters translate the deployable subset to the provider's expected schema draft without changing its meaning. Returned values are validated again against the canonical schema before downstream blocks receive them.
- Invalid or provider-unsupported schemas block deployment with the exact unsupported schema paths.
- A schema violation is an execution failure, not malformed normal output.
- Every block with user-configurable structured output, including Generic Agent and Call LLM, supports both:
  - a field-based visual schema editor for objects, arrays, types, descriptions, and required fields; and
  - an advanced raw JSON Schema editor that also supports pasting a complete schema.
- Switching between supported visual and raw representations must not lose information. Raw features that the visual editor cannot represent remain intact and are identified clearly.
- Raw mode preserves any valid JSON Schema 2020-12 exactly in a draft, including unsupported keywords, but unsupported paths block deployment.
- Visual mode covers the entire initially deployable subset, making visual/raw round-tripping lossless for every deployable schema.
- Invalid visual configurations show field-level errors.
- The editor previews the output variables generated from the schema.

### Prompt authoring

- Replace prompt-content blocks in the standard authoring flow with one continuous prompt editor.
- The editor supports inline workflow-variable and prompt-library references.
- References remain references; the editor must not silently copy their current text into the prompt.
- Raw and visual editing preserve reference tokens, and missing references block deployment.
- The effective-prompt preview shows base text, prompt-library references, workflow values, and runtime instructions in execution order.
- Every injected section identifies its source and precedence.
- Preview values are sanitized, and the preview follows the same construction contract used at execution time.
- Security, workspace permissions, publication rules, mandatory checks, and output validation are code-enforced invariants, not prompt instructions. They cannot be overridden by a profile, repository, block prompt, or runtime value.
- The prompt-level instruction sources, from least to most specific, are:
  1. Harness Profile instructions for provider-wide configuration and reusable harness behavior;
  2. repository-native `AGENTS.md` and `CLAUDE.md` instructions; and
  3. the block's visible role/task prompt.
- A more specific prompt instruction can override a less specific prompt instruction, but none can override a code-enforced invariant or the block's semantic contract.
- Ticket data, repository context, plans, and upstream outputs are injected as clearly delimited runtime data, not treated as another instruction layer.
- AI Workflow does not introduce a separate organization instruction layer or `.ai/workflow` instruction file initially. Organization-wide reusable behavior belongs in Harness Profiles.
- Operational rules that become code-enforced or profile-wide are removed from duplicated block prompts.

### Explicit block inputs and transforms

- Supported blocks can declare additional typed, named inputs.
- Users can add, rename, configure, bind, and remove those inputs.
- Bindings can only select data guaranteed to be available on every valid incoming path.
- Deployment validates input/output schema compatibility.
- The editor can show a sanitized current value or example value for a binding.
- Context filtering and reshaping use an explicit Transform block rather than hidden arrow behavior.
- Transform authoring uses a finite set of product-defined declarative operations.
- Transform does not execute JavaScript, JSONata, or another user-authored expression language in its initial version.
- Because Transform cannot execute arbitrary code, it does not require a JavaScript sandbox or code-isolation boundary.
- A Transform receives only explicitly bound JSON inputs and returns a JSON-serializable result.
- Transform use cases include projection, field renaming, combining upstream values, filtering arrays, calculating counts/booleans, and normalizing provider output.
- One Transform block performs one operation. Multi-stage transformations chain visible Transform blocks rather than hiding an internal operation pipeline.
- The initial operations are:
  - **Map object**: select, rename, and combine fields, and add literal or default values.
  - **Filter array**: retain array items using typed field conditions.
- Additional operations are added only after real workflow usage demonstrates a gap.

### Harness profiles and specialized agent blocks

- A harness profile represents the complete reusable harness environment, not just model selection. It includes provider/CLI version, the equivalent of the complete harness home configuration (for example `codex.toml` and other materialized home-directory files), context and compaction settings, subagent and budget settings, declared skills/tools/MCP integrations, workspace behavior, and harness-wide instructions.
- Profiles are named and versioned. A run records the exact resolved profile manifest.
- Editing a profile already used by a deployed workflow creates a new version rather than changing historical behavior.
- Skill and tool origins are pinned to a version, revision, or verified hash. They do not update silently.
- Credentials are runtime references and are never stored inside a profile or instruction text.
- Planning, Implementation, Review, Fix, and Generic Agent remain distinct block types with visible semantic contracts. Harness profiles do not replace these blocks, and the block's semantic contract does not come from the selected profile.
- Only declared skills, tools, and MCP integrations are loaded.
- Installed versions or hashes are verified, and runs never update or download skills implicitly.
- An explicit administrator refresh may create a new pinned artifact and a new profile version.
- Run metadata lists the skills and tools actually available to the harness.
- The Harness Profile editor lets users add skills directly from GitHub with a skills.sh-like flow:
  - accept a GitHub `owner/repository`, a full repository URL, or a direct path to a skill inside a repository;
  - discover valid skills in the source and let the user select one or more to add; and
  - show the selected skill's repository, path, and pinned source revision.
- GitHub skill import supports public repositories and private repositories accessible through the organization's configured GitHub connection. Repository permissions are respected, and no separate personal credential is stored in the Harness Profile.
- Adding or refreshing a GitHub skill changes the profile draft. Publishing that change creates a new Harness Profile version; an existing deployed workflow never receives the new skill or a later upstream revision silently.
- If a source or selected skill cannot be fetched or validated, the profile cannot publish and shows an actionable error.
- Existing agent blocks receive a documented compatibility profile when profiles are introduced.
- Every specialized agent block has a visible, version-pinned Harness Profile reference.
- Built-in blocks select a compatible default profile. Several block types may share the same built-in profile version when their harness configuration is identical.
- Users can select another compatible profile or fork the selected profile.
- Forking creates an independently editable profile. Editing a profile that has already been used creates a new version.
- Deployed Workflow Definitions remain pinned to their selected profile version until explicitly updated.
- Effective capabilities are the intersection of the selected profile and the block's semantic safety envelope. A profile cannot change the block type or grant capabilities forbidden by its contract.
- The block's role prompt remains visible and separately editable from its Harness Profile.
- There is no separate persisted “preset” entity initially. AIW-130 instead makes each specialized block's purpose, profile, prompt, tools, expected output, context limits, compaction, and subagent behavior visible and editable.

### Execution failures, domain outcomes, checks, and branching

- Remove per-step execution-error output paths.
- Sandbox, provider, parser/schema, and workflow-engine failures fail the workflow at the top level. They do not become normal step outputs and do not require a failure branch on every block.
- The failed block is still shown with an X, safe error message, and diagnostic ID; raw provider errors and stack traces are not exposed as output.
- A negative review, rejected check, or failed command is a valid typed domain result when the block executed correctly.
- The generic Branch block remains. It branches on typed domain output such as `approved`, `passed`, or an equivalent result field.
- Standard Review and Check templates automatically create or configure the normal domain-result branches so users do not have to author boilerplate conditions manually. The branch remains visible and editable.
- An inability to execute a check is an execution failure. A command that ran and exited unsuccessfully is a typed check result.
- Applicable repository Pre-PR checks remain mandatory before publication.
- Check configuration supports ordered multiline commands and reports a result for each command.
- Missing check configuration and intentionally skipped checks are distinguishable.
- Branch-condition autocomplete only offers available upstream fields.
- Operators depend on the selected field type, and a branch condition must resolve to a boolean.
- Missing fields, invalid paths, type errors, and non-boolean expressions block deployment with a precise error.

### Observability, persistence, and replay

- Persist only a sanitized observation copy; execution data itself is not mutated by sanitization.
- Redaction is deterministic and local, not LLM-based.
- Sanitization covers configured secrets, tokens, JWTs, private keys, credential URLs, emails, phone numbers, and payment identifiers, including nested values.
- Authorization headers, cookies, environment files, and credential-bearing command arguments are never captured.
- Redaction and truncation metadata are recorded.
- Unsafe historical diagnostic previews are removed or made inaccessible.
- Each block attempt records state, typed domain result, sanitized input/output, timing, and diagnostic ID against the exact workflow-definition version.
- Every retry or loop execution is a separate attempt while the block-level status remains a summary.
- Diagnostic APIs are authenticated and size-limited.
- Clicking a block during a live or completed run opens an inspector with Input, Output, Logs, Metadata, and Attempts views.
- Live inspector values update for the selected run and exact workflow-definition version.
- The initial debugger/replay experience is read-only visual replay. It highlights the path taken, current/completed blocks, attempts, timing, inputs, outputs, logs, and metadata.
- Replay never reruns a step or repeats a side effect.
- Debugger data has a 30-day default retention period.
- Default size limits are 64 KiB for each captured input, output, and log tail, with a 256 KiB total cap per attempt. Truncation and redaction are labeled.

### Editor history, clipboard, and canvas behavior

- `Ctrl/Cmd+Z` undoes graph and configuration changes; `Ctrl/Cmd+Shift+Z` redoes them.
- A completed block drag is one transactional history entry.
- Backspace/Delete removes selected nodes or edges when focus is outside text inputs.
- Right-click deletion requires confirmation.
- Copy/paste assigns new node IDs, offsets pasted nodes, and preserves valid configuration.
- The required trigger block cannot be removed accidentally.
- Users can adjust and persist control-edge curvature without changing workflow semantics.
- Grid spacing scales and pans with canvas zoom.
- Selecting a variable or block highlights its data sources without turning those highlights into control-flow edges.
- Editor labels, pickers, and menus are keyboard-accessible and use task-oriented names.

### Editor validation behavior

- Validation feedback must not change the workflow editor's layout or move the canvas, configuration panel, fields, or pointer target while the user is editing.
- Remove the current in-flow yellow validation banner.
- Validation issues are errors, not warnings, and use a red error treatment.
- An issue associated with a block is presented on that block:
  - the block has a red error outline on the canvas;
  - selecting the block opens its configuration panel with its validation-error section already expanded; and
  - that section lists the actionable errors for the selected block.
- Issues that are not associated with a block may be shown at workflow level, but their presentation must be an overlay, popover, drawer, or other non-layout-shifting surface.
- The header validation state can show the total issue count without expanding an in-flow issue list.
- Background validation runs only after both conditions are true:
  - no semantic editor change has occurred for five seconds; and
  - no block is focused/selected for editing.
- Selecting or continuing to edit a block postpones background validation. Clearing the block focus allows the five-second idle rule to complete.
- Save and Deploy always trigger immediate validation of the exact current draft, without waiting for the background debounce.
- An invalid draft remains saveable so users do not lose incomplete work. Save persists the draft and presents the immediate validation result through the block-level and workflow-level error UI above.
- Deploy proceeds only when immediate validation succeeds. A failed validation blocks deployment and presents the errors through the same UI.
- Save and Deploy must not rely on a stale result from an earlier draft.

### Naming and compatibility

- New branch names use `ai-workflow/<ticket-or-run-identifier>`.
- New GitHub checks use the `AI Workflow / <name>` namespace.
- Existing durable branch names, check names, integrations, stored runs, and historical records continue to resolve through explicit compatibility aliases. Historical data is not rewritten.
- Renaming the actual GitHub App or Slack identity is outside this backlog unless a separate requirement is approved.

### PR review-comment ingestion

- A human PR review comment reaches the correct workflow run and Fix/Review block.
- Both legacy and Workflow Definition v2 paths are covered.
- Duplicate webhook deliveries do not create duplicate runs.
- AI Workflow's own comments cannot recursively trigger another workflow.
- Failed ingestion is observable through a safe diagnostic ID.
- AIW-140 is limited to gaps that remain after the merged review-ingestion work, rather than reimplementing already-shipped behavior.

## Specification status

No unresolved product decisions remain in this specification. The implementation plan and PR and migration boundaries remain intentionally deferred until the user explicitly authorizes planning.

## Ticket map and current specification status

| Backlog item | Jira | Specification status |
| --- | --- | --- |
| Workflow Definition v2 | AIW-119 | New foundation |
| Execution failures vs outcomes | AIW-120 | Audit against merged AIW-105; retain only the v2/top-level-failure delta |
| Structured outputs across providers | AIW-121 | Audit against merged AIW-106; retain schema normalization/validation gaps |
| Structured schema editor | AIW-122 | New UI on canonical JSON Schema |
| Trigger and step references | AIW-123 | New v2 reference grammar and migration |
| Continuous prompt editor | AIW-124 | Audit current editor first; retain continuous authoring and explicit Prompt Slot validation |
| Effective prompt preview | AIW-125 | Show the locked instruction sources, runtime-data provenance, and precedence |
| Explicit extensible inputs | AIW-126 | Audit against AIW-92; retain missing bindings/transform work |
| Versioned harness profiles | AIW-127 | New foundation shared by agent work |
| Deterministic tools and skills | AIW-128 | Add skills.sh-like GitHub import while retaining exact source pinning |
| Global runtime instructions | AIW-129 | Use code invariants, Harness Profile instructions, repository-native files, and block prompts; no extra instruction store |
| Agent naming/presets | AIW-130 | No standalone preset entity; clarify specialized-block configuration and behavior |
| Parallel fan-out/fan-in | AIW-131 | New runtime/editor capability |
| Branch authoring | AIW-132 | Build on typed outputs and references |
| Run Checks and Pre-PR Checks | AIW-133 | Preserve Branch; auto-generate domain branches |
| Redaction | AIW-134 | Foundation for persisted diagnostics |
| Per-block attempts | AIW-135 | Persist sanitized observation data |
| Workflow debugger/replay | AIW-136 | Read-only replay only |
| Editor history/clipboard | AIW-137 | Independent editor workstream |
| Canvas geometry/data visibility | AIW-138 | Independent editor workstream |
| Validation timing and error UX | AIW-144 | New editor validation presentation and timing work |
| AI Workflow terminology | AIW-139 | Compatibility-aware rename |
| PR review-comment ingestion | AIW-140 | Audit merged AIW-141/PR #130; retain only uncovered v2/legacy gaps |

## Delivery constraints reserved for the later implementation plan

- Use a few coherent stacked PRs rather than one large PR or one PR per ticket.
- Consolidate database migrations rather than creating one for every ticket.
- Update the covered Jira tickets together according to the locked lifecycle above.
- Do not infer PR boundaries, migration boundaries, or implementation order from this specification. Those belong to the separately authorized implementation plan.
