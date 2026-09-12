Status: current
Last-verified: 2026-09-12

# Workflow definitions (schema v2)

A workflow definition is the stored, versioned graph that decides what a run
does. This document describes schema v2, the only schema that runs, deploys or
can be authored. Schema v1 is retired by
[ADR-003](../adr/ADR-003-definition-schema-v1-retirement.md) and its code is
removed in stage 3b of
[the restructure plan](../plans/2026-09-09-architecture-restructure.md); stored
v1 history rows stay readable and are out of scope here.

Every claim below is checked against the code that enforces it. Paths are given
without line numbers on purpose: line numbers go stale, file ownership does not.

## 1. Shape of a definition

The rules below have three homes, and which home a rule has says what it is
allowed to know. Structural rules, the ones that need only the graph, live in
the workspace package `@shared/workflow-graph` (`packages/workflow-graph/`):
`schema.ts` parses, `graph-issues.ts` reports, `limits.ts` holds the two size
caps. Deployment rules, the ones that read the environment, the block registry
or a clock, live in `apps/worker/src/workflow-definition/deployment-validation.ts`,
which composes both halves into the one ordered list an author reads. The block
parameter schemas and the block contract resolver the structural rules need are
handed in as parameters, never imported, which is what keeps the package free of
the worker. `apps/worker/src/workflow-definition/schema.ts` is a re-export left
for two engine importers and is deleted by stage 7 of
[the workflow graph plan](../plans/2026-09-11-workflow-graph-package.md).

A definition is an object with `schemaVersion: 2`, `nodes`, `edges`, and two
optional graph-level fields, validated by `workflowDefinitionV2Schema` in
`packages/workflow-graph/schema.ts`:

| Field | Meaning |
|---|---|
| `schemaVersion` | the literal `2` |
| `nodes` | the blocks, capped by `MAX_NODES` |
| `edges` | the control connections, capped by `MAX_EDGES` |
| `budgets` | optional `maxDurationMs`, `maxTokens`, `maxCostUsd`, each a positive number |
| `repositoryScope` | optional pinned repositories, at most eight, each `{provider, repoPath}` |

The object is strict: an unknown top-level key is a validation error rather than
an ignored field.

## 2. Nodes

Each node carries identity, position, and three data surfaces
(`workflowDefinitionV2NodeSchema` in the package's `schema.ts`):

| Field | Meaning |
|---|---|
| `id` | addressable name, unique in the graph; `entry` is reserved |
| `type` | a key of `BLOCK_TYPE_SPECS` in `packages/contracts/workflow-graph.ts` |
| `name` | optional display label |
| `x`, `y` | editor coordinates, finite numbers |
| `configuration` | the block's own authored settings, one typed schema per block type |
| `inputs` | the block's fixed inputs, each mapped to a binding |
| `additionalInputs` | up to 100 author-declared inputs, each `{name, schema, binding}` |

`configuration` is stored as a plain JSON record and validated per block type
against the per-type parameter schemas the worker composes in
`apps/worker/src/engine/definition/block-params-schemas.ts` and hands to
`workflowDefinitionStructuralIssues`. Transform and Branch have their own typed
configuration validators in the package and accept no generic input
mappings at all: a mapped input on either block type is an `unknown_input`
issue.

Node ids must satisfy `isWorkflowAddressablePathSegment` in
`packages/contracts/workflow-graph.ts`, because a node id is also a path
segment inside data references. Input names must satisfy
`isSafeWorkflowInputName` in the same file, which allows dots as authored
segments and rejects prototype-mutating names.

## 3. Block types and ports

`BLOCK_TYPE_SPECS` in `packages/contracts/workflow-graph.ts` is the catalog:
one entry per block type, giving its category (`trigger`, `action`, `control`),
its ports, and whether it allows a failure port. Derived from it in the same
file:

- `TRIGGER_BLOCK_TYPES` and `isTriggerBlockType`: which types can start a run.
- `MANUALLY_DISPATCHABLE_TRIGGER_TYPES` and `NON_DISPATCHABLE_TRIGGER_TYPES`:
  the two exhaustive halves that decide whether the dashboard may offer a
  manual run. A gate test asserts they partition the trigger list.
- `BLOCK_PARAM_KEYS`: the configuration keys each block type accepts.
- `WORKFLOW_PROMPT_PARAM_KEYS`: which string fields carry authored prose, so
  prompt and reference visitors never rewrite machine-shaped strings such as a
  Branch condition or a JSON Schema source.
- `wirablePorts`: the ports an editor may draw from.

Control blocks have fixed ports: `branch` has `true` and `false`, `loop` has
`continue` and `exhausted`, `terminate` has none. `send_plan_approval` also has
no outgoing port: it ends its path.

The failure port is v1 vocabulary. In v2 the validator in `graph-issues.ts` rejects
any edge whose `fromPort` is the failure port.

## 4. Edges

An edge is `{id, from, to, fromPort?}` (`workflowDefinitionV2ControlEdgeSchema`
in the package's `schema.ts`). The port defaults to the block type's first port,
so an edge out of a multi-port block must name its port explicitly. The graph
validator behind `workflowDefinitionStructuralIssues` in
`packages/workflow-graph/graph-issues.ts` enforces:

- unique edge ids, and no duplicate `from` plus port plus `to` triple;
- both endpoints exist, and no self connection;
- the named port exists on the source block type, and a terminal block has no
  outgoing edge at all;
- at least one trigger block, and no incoming edge into a trigger;
- every non-trigger block reachable from some trigger;
- both Branch ports connected, the Loop `continue` port connected, and the
  Loop `exhausted` port connected when `onExhaust` is `continue`;
- the Loop `continue` port leads back to its own Loop;
- no cycle that does not pass through a Loop, exactly one Loop per cycle
  region, and no `finalize_workspace` inside a cycle region.

Two triggers may point at the same block; in-degree is not capped.

## 5. Bindings

Data flows through bindings, not through edges. Edges carry control only.

A binding is one of three kinds (`workflowInputBindingV2Schema` in the
package's `schema.ts`), resolved by
`packages/workflow-graph/v2-bindings.ts`:

| Kind | Payload | Resolves to |
|---|---|---|
| `reference` | one canonical data reference | the value at that path |
| `reference_list` | a non-empty array of references | an array of those values |
| `literal` | any JSON value | a copy of that value |

A data reference is a dot path with one of three roots, parsed by
`parseWorkflowDataReferenceV2` in `v2-bindings.ts`:

- `steps.entry.output.*`: the output of the trigger that started this run.
  `entry` is reserved as a node id for exactly this reason.
- `steps.<nodeId>.output.*`: the output of another block.
- `run.*`: run-level values.

Resolution reads own properties only, refuses `__proto__`, `prototype` and
`constructor` segments, deep-clones what it returns, and throws when the path
is absent, so a missing value fails the run instead of silently becoming null.
`resolveWorkflowNodeInputsV2` merges `inputs` and `additionalInputs` into one
map and rejects a name declared twice.

Prompt-bearing fields may embed the same references as `{{data:<reference>}}`
tokens; `resolveWorkflowPromptDataTokensV2` in `v2-bindings.ts` resolves them
again at invocation time so a stale checkpoint cannot leak a raw placeholder
into an agent prompt.

Which references an author may pick is computed per node by
`analyzeWorkflowValues` in
`packages/workflow-graph/available-values.ts`, which also produces
the per-node contracts, the available values and (through
`analyzeWorkflowV2Catalog`) the data catalog the editor shows. A binding to an
unknown block, or a block binding to its own output, is a validation error in
`graph-issues.ts`.

## 6. Triggers

Trigger blocks are the entry points. Their configuration is validated by the
per-type parameter schemas and their runtime selection happens in
`apps/worker/src/services/dispatch/dispatch.ts` and
`apps/worker/src/services/dispatch/dispatch-trigger.ts`.

Common ground: every trigger type accepts an optional start budget
(`rateLimitMax` with a fixed `rateLimitWindow` of `minute`, `hour`, `day` or
`month`). Pull request triggers additionally take `providers` and a `scope` of
`workflow_owned` or `any`. Beyond that each type has its own keys, listed in
`BLOCK_PARAM_KEYS` in `packages/contracts/workflow-graph.ts`: check names
and pipeline sources for `trigger_pr_checks_failed`, review states for
`trigger_pr_review`, the signature and mapping paths for `trigger_webhook`,
the cron expression, timezone and overlap policy for `trigger_schedule`.

The v2 validator does not cap how many triggers of one type a graph carries; it
requires at least one trigger and no incoming edge into one.

One deployment rule is worth naming because it is easy to hit: a
`prepare_workspace` block reachable from a schedule trigger in a workflow that
pins no repository is rejected, because a scheduled run carries no ticket and
therefore nothing that names a repository (`workflowScheduleGraphIssues` in
`graph-issues.ts`, reported at the tail of the worker's deployment walk).

## 7. Harness profiles and prompts

Agent blocks (`planning_agent`, `implementation_agent`, `review_agent`,
`fix_agent`, `generic_agent`) accept two authoring fields inside
`configuration`, allowed through the per-type parameter schemas:

- `harnessProfile`: `{profileId, version}`, a pinned reference to a stored
  harness profile;
- `promptSlotBindings`: a binding per named prompt slot.

`normalizeV2AgentProfileConfiguration` in the package's `schema.ts` normalizes the profile
reference before parsing. Resolution and existence checks live in
`apps/worker/src/workflow-definition/harness-profile-runtime.ts`
(`resolveHarnessRuntimesForDefinition`, `validateHarnessProfileReferences`),
which is what turns a pinned profile into the runtime an agent block executes
with. Prompt authoring and the prompt reference shape are handled by
`apps/worker/src/workflow-definition/prompt-authoring.ts`.

## 8. Loops, regions and carries

A Loop block bounds the single legal re-entry point of a cycle. Its
configuration (`v2LoopConfiguration` in the package's `schema.ts`) is `maxAttempts` (1 to
20), `onExhaust` (`fail`, `human` or `continue`), and an optional `carry` array
of at most 100 entries, each `{name, schema, binding}`.

At runtime `buildV2RuntimeGraph` in
`apps/worker/src/workflow-definition/v2-scheduler.ts` derives a `V2LoopRegion`
per Loop: the member blocks that belong to the cycle, plus whether the region
has an external entry into its body. Each iteration runs in an activation
scope (`V2ActivationScopeState`) with its own edge tokens, node states and
outputs, so a second iteration cannot read the first iteration's values by
accident.

Carried values are resolved once per iteration by the scheduler, validated
against the declared JSON Schema of the carry entry, and rejected when a name
repeats, when the value is not JSON serializable, or when it does not match its
schema (`v2-scheduler.ts`). A region also records that control has left it
(`loopRegionExited`), because an active edge crossing the region boundary is
not proof that the region was exited: a member may fan out on a port that also
continues inside the region.

## 9. Branch conditions

A Branch is typed data, not an expression string. Its configuration is
`{combinator, conditions}` where `combinator` is `all` or `any` and each
condition is `{reference, operator, value?, ignoreCase?}` with the operator
drawn from a fixed list (`equals`, `not_equals`, `contains`, `not_contains`,
the four comparisons, `has_value`, `has_no_value`), defined by
`v2BranchConfigurationSchema` in the package's `schema.ts`. Conditions are
checked against the available-values catalog of the node in
`workflowValueReferenceIssues` in `graph-issues.ts`, so a Branch that
reads a field no upstream block produces fails validation rather than the run.

## 10. Validation and deployment

One entry per policy: three questions a caller can ask about a definition, each
declared in `packages/workflow-graph/policies.ts`. `parse` produces the upgraded
definition; `deploy` and `runLoad` take that definition rather than parsing
again, which is what keeps a request to one parse, and each composes the
structural rules with the worker-only half and de-duplicates the list it
composed.

| Policy | Question | Who calls it |
|---|---|---|
| `parse` | Read this graph into the runnable shape, check nothing else | the repository read path (`workflow-definition/stored-definition.ts`, reached through `engine/stored-definition-reads.ts`), `validation.ts`, `services/workflow-definitions/definition-candidates.ts`, `engine/steps/definition-step.ts`, `workflow-definition/scenarios/harness.ts`. One exception remains: `services/workflow-definitions/policy-operations.ts:82` still parses with `workflowDefinitionV2Schema.safeParse` and throws a flat 400 string, and nine call sites in that file go through it; the stage that owns `policy-operations.ts` repoints them |
| `deploy` | May it become executable here, environment availability included | `deployment-validation.ts`, and through it `validation.ts` and `services/workflow-definitions/policy-operations.ts` |
| `runLoad` | The same about a graph that already deployed, availability skipped | `deployment-validation.ts` (`validateWorkflowDefinitionForRunLoad`), called by `engine/steps/definition-step.ts` and the scenario harness |

**De-duplication is not single-pass, on purpose.** The graph walk dedupes its
own list inside `graph-issues.ts:1039`, because
`workflowDefinitionStructuralIssues` is a public entry that has to return a
clean list to anyone calling it directly; the policy then dedupes once across
the composed list, which is the only dedupe a caller of a policy has to think
about. Both use `dedupeWorkflowDefinitionIssues`, the only de-duplication in
workflow validation. `packages/prompts` still keeps two of its own,
`prompt-authoring.ts:271` (identical) and `effective-prompt.ts:686` (keyed on
`code`, `path` and `message`, so it merges the same complaint on different
nodes); folding them in needs a `@shared/workflow-graph` edge that package does
not have yet.

**Save.** An unsaved candidate is parsed with the schema and then measured
against the `deploy` policy, and its issues are reported without refusing the
save, so an operator can keep editing a structurally sound but incomplete graph.
There is deliberately no structural-only policy: narrowing the save path to one
would drop block availability and cron rules, binding analysis, branch and
transform reference checks, workspace access and the repository pin out of what
an operator sees at save time, and that decision is open. The entry
point is `validateWorkflowDefinitionCandidate` in
`apps/worker/src/workflow-definition/validation.ts`, which refuses a retired
`schemaVersion` by name, runs `parse`, and returns machine-readable issues
carrying `code`, `severity`, `nodeId` and a JSON pointer `path`, with per-node
contracts and available values attached for the editor. Callers never recover
structure by parsing messages.

**Deployment.** `validateWorkflowDefinitionIssuesForDeployment` in
`apps/worker/src/workflow-definition/deployment-validation.ts` is what a
definition must pass before it can run: it wraps the `deploy` policy (or
`runLoad` when the caller passes `checkEnvironmentAvailability: false`) and
hands it the worker-only half as one injected issue source, so the package
never learns what backs it. For a v2 definition the composed list runs, in one
pass: the graph rules of section 4 and the per-type configuration schemas (the
policy's own structural half), then the block deployment rules from
`apps/worker/src/workflow-definition/block-registry.ts`, the binding analysis
from `packages/workflow-graph/available-values.ts`, the Branch condition and
Transform reference checks, the workspace access rules from
`packages/workflow-graph/workspace-access.ts`, and the repository
scope pin rules. That order is behaviour: an author reads one list, and
`__golden__/definition-deployment-issues.test.ts` pins it byte for byte.

**Block data is a parameter, never a read.** Neither the schemas nor the
binding analysis asks what this installation has configured. A block's contract
(its output schema, its binding schema and whether it is available at all)
follows from its own params plus the deployment, so the rules take a
`WorkflowBlockContractResolver` (`packages/contracts/block-contract-resolver.ts`,
`(type, params) => WorkflowBlockContract`) and the per-type parameter schema map
composed in `apps/worker/src/engine/definition/block-params-schemas.ts`. The
worker binds a resolver to the running deployment in
`apps/worker/src/engine/definition/block-contract-resolver.ts`, reading the
environment only in `block-contract-environment.ts`, and
`apps/worker/src/services/workflow-definitions/block-contracts.ts` builds both
once per request: validation, available values and the editor's block table then
answer about one deployment rather than three separate reads of it. The
definition-level repository pin belongs to no block, so it cannot be checked
through the resolver; the same per-request object carries the configured VCS
provider list that check takes. That object also carries the analyser
(`analyzeValues`) behind the single available-values pass
(`analyzeWorkflowValues` in `available-values.ts`): one request walks the graph,
resolves its contracts and builds its offered catalog once, and hands that
`WorkflowValueAnalysis` to draft validation, the data catalog and prompt
authoring instead of each walking it again.

Workspace access deserves a note: `workflowWorkspaceAccessOf` in
`workspace-access.ts` classifies each block as `none`, `shared_read`,
`shared_write` or `isolated_review`, and
`validateWorkflowV2WorkspaceAccessIssues` rejects graphs whose concurrent paths
would need conflicting access to the same workspace.

## 11. Runtime

`executeV2Graph` in `apps/worker/src/workflow-definition/v2-scheduler.ts` walks
a deployed graph. It keeps a checkpoint (`V2SchedulerCheckpoint`) holding the
entry trigger and its output, every activation scope, attempt counts, the ready
queue, pending clarifications and answers, so a run can pause on a human
question and resume on the answer. Edges carry a token (`unresolved`, `active`,
`inactive`), nodes carry a status (`waiting`, `ready`, `running`,
`waiting_loop`, `waiting_for_clarification`, `completed`, `skipped`,
`cancelled`, `failed`), and the walk is bounded by
`V2_PRODUCTION_SCHEDULER_BOUNDS` (maximum concurrency and maximum total block
executions). Execution errors are shaped by
`apps/worker/src/workflow-definition/interpreter.ts`, which owns the safe
message set and the one construction path a failed block reports through, while
the execution error class, the sentence a user reads and the operator log event
are engine concerns in `apps/worker/src/engine/helpers/execution-error.ts`. The
failure a run records is plain data declared in
`packages/contracts/execution-error.ts`, so the scheduler mints and carries one
without touching the engine. A Transform block's regex replacement is the one
transform operation that cannot be pure, so `transform.ts` takes an async regex
evaluator as a parameter and refuses a regex transform without one, and
`apps/worker/src/engine/steps/transform-regex-step.ts` stays the only loader of
`re2-wasm` and supplies the evaluator the workflow injects.

## 12. Storage, versions and deployment state

`apps/worker/src/db/repositories/definitions.ts` owns the atomic definition
creation and schedule-revocation writes; the service
`apps/worker/src/services/workflow-definitions/policy-operations.ts` owns the
remaining version lifecycle reads and writes. A definition
row carries `draftRevision`, `deployedVersion` and `archivedAt`; every save
appends a version row, and the head version is the draft. Dispatch reads the
deployed version only, and refuses a definition that is disabled, archived, or
has no deployed version. An archived definition is invisible to authoring: the
MCP read returns `NOT_FOUND` for it, matching the dashboard route.

## 13. Authoring over MCP

`apps/worker/src/mcp/tools/workflow-authoring.ts` registers the authoring
tools, and `apps/worker/src/mcp/tool-catalog.ts` is the contract that names
them: `workflows.list`, `workflows.get_graph`, `workflows.create`,
`workflows.save_draft`, `workflows.publish`, `workflows.set_enabled`,
`workflows.dispatch_preflight` and `workflows.dispatch`.

Three properties matter to anyone authoring a graph through an agent:

- `workflows.create` seeds nothing. An empty definition is inert, and publish
  refuses it until a draft exists.
- `workflows.save_draft` takes `expectedDraftRevision` and `workflows.publish`
  takes `expectedDeployedVersion`, so a concurrent edit is rejected rather than
  silently overwritten. `workflows.get_graph` returns both tokens along with
  the draft and deployed graphs and their digests, read through the same path
  that the writes hash, so a caller can confirm a round trip.
- A publish neither enables nor disables a definition. Enablement is a separate
  switch (`workflows.set_enabled`), and a publish onto an already enabled
  definition is what makes new events execute the new graph.

## 14. Where the code lives

| Concern | File |
|---|---|
| Definition schema, stored-shape upgrade, size limits | `packages/workflow-graph/schema.ts`, `packages/workflow-graph/limits.ts` |
| Structural graph rules, branch and transform references, any-scope review safety | `packages/workflow-graph/graph-issues.ts` |
| Deployment validation and the order the two halves compose in | `apps/worker/src/workflow-definition/deployment-validation.ts` |
| The golden fixture that pins that order | `apps/worker/src/workflow-definition/__golden__/`, recorded by `apps/worker/scripts/capture-definition-issue-golden.ts` |
| Candidate validation for the API | `apps/worker/src/workflow-definition/validation.ts` |
| Block catalog, ports, param keys | `packages/contracts/workflow-graph.ts` |
| Block contracts and registry rules | `apps/worker/src/workflow-definition/block-registry.ts` |
| Deployment-aware contracts and the resolver | `apps/worker/src/engine/definition/block-contract-resolver.ts`, `apps/worker/src/engine/definition/block-contract-environment.ts` |
| Per-type block parameter schemas | `apps/worker/src/engine/definition/block-params-schemas.ts` |
| Block data bound once per request | `apps/worker/src/services/workflow-definitions/block-contracts.ts` |
| Binding resolution | `packages/workflow-graph/v2-bindings.ts` |
| Available values and node contracts | `packages/workflow-graph/available-values.ts` |
| Value schema assignability and the run binding schema | `packages/workflow-graph/bindings.ts` |
| Transform semantics, shape and output schema | `packages/workflow-graph/transform.ts` |
| Authored JSON Schema inspection | `packages/workflow-graph/json-schema-authoring.ts` |
| The ajv-backed JSON Schema facility the package takes as a parameter | `apps/worker/src/workflow-definition/json-schema.ts`, bound in `apps/worker/src/engine/definition/json-schema-support.ts` |
| Scheduler, loop regions, checkpoints | `apps/worker/src/workflow-definition/v2-scheduler.ts` |
| Execution results and error construction | `apps/worker/src/workflow-definition/interpreter.ts` |
| Execution error shape, category and recorded state | `packages/contracts/execution-error.ts` |
| Execution error class, user sentence, log event | `apps/worker/src/engine/helpers/execution-error.ts` |
| Harness profile resolution | `apps/worker/src/workflow-definition/harness-profile-runtime.ts` |
| Workspace access rules | `packages/workflow-graph/workspace-access.ts` |
| Persistence and versions | `apps/worker/src/db/repositories/definitions.ts`, `apps/worker/src/services/workflow-definitions/policy-operations.ts` |
| MCP authoring tools | `apps/worker/src/mcp/tools/workflow-authoring.ts` |
