Status: current
Last-verified: 2026-09-09

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

A definition is an object with `schemaVersion: 2`, `nodes`, `edges`, and two
optional graph-level fields, validated by `workflowDefinitionV2Schema` in
`apps/worker/src/workflow-definition/schema.ts`:

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
(`workflowDefinitionV2NodeSchema` in `schema.ts`):

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
against `v2ConfigurationSchemas` in `schema.ts`. Transform and Branch have
their own typed configuration validators there and accept no generic input
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

The failure port is v1 vocabulary. In v2 the validator in `schema.ts` rejects
any edge whose `fromPort` is the failure port.

## 4. Edges

An edge is `{id, from, to, fromPort?}` (`workflowDefinitionV2ControlEdgeSchema`
in `schema.ts`). The port defaults to the block type's first port, so an edge
out of a multi-port block must name its port explicitly. The graph validator
`validateWorkflowGraphV2Issues` in `schema.ts` enforces:

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

A binding is one of three kinds (`workflowInputBindingV2Schema` in
`schema.ts`), resolved by
`apps/worker/src/workflow-definition/v2-bindings.ts`:

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
`analyzeWorkflowV2Bindings` and `analyzeWorkflowV2Catalog` in
`apps/worker/src/workflow-definition/available-values.ts`, which also produce
the per-node contracts and available values the editor shows. A binding to an
unknown block, or a block binding to its own output, is a validation error in
`schema.ts`.

## 6. Triggers

Trigger blocks are the entry points. Their configuration is validated by the
per-type schemas in `schema.ts` and their runtime selection happens in
`apps/worker/src/lib/dispatch.ts` and
`apps/worker/src/lib/dispatch-trigger.ts`.

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
therefore nothing that names a repository (`schema.ts`).

## 7. Harness profiles and prompts

Agent blocks (`planning_agent`, `implementation_agent`, `review_agent`,
`fix_agent`, `generic_agent`) accept two authoring fields inside
`configuration`, defined by `v2PromptAuthoringConfiguration` in `schema.ts`:

- `harnessProfile`: `{profileId, version}`, a pinned reference to a stored
  harness profile;
- `promptSlotBindings`: a binding per named prompt slot.

`normalizeV2AgentProfileConfiguration` in `schema.ts` normalizes the profile
reference before parsing. Resolution and existence checks live in
`apps/worker/src/workflow-definition/harness-profile-runtime.ts`
(`resolveHarnessRuntimesForDefinition`, `validateHarnessProfileReferences`),
which is what turns a pinned profile into the runtime an agent block executes
with. Prompt authoring and the prompt reference shape are handled by
`apps/worker/src/workflow-definition/prompt-authoring.ts`.

## 8. Loops, regions and carries

A Loop block bounds the single legal re-entry point of a cycle. Its
configuration (`v2LoopConfiguration` in `schema.ts`) is `maxAttempts` (1 to
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
`v2BranchConfigurationSchema` in `schema.ts`. Conditions are checked against
the available-values catalog of the node in
`validateWorkflowV2BranchConditionIssues` in `schema.ts`, so a Branch that
reads a field no upstream block produces fails validation rather than the run.

## 10. Validation and deployment

There are two levels, and the difference is deliberate.

**Save.** A draft is parsed with the schema and the graph rules only, so an
operator can keep editing a structurally sound but incomplete graph. The entry
point is `validateWorkflowDefinitionCandidate` in
`apps/worker/src/workflow-definition/validation.ts`, which picks the schema by
`schemaVersion`, returns machine-readable issues carrying `code`, `severity`,
`nodeId` and a JSON pointer `path`, and attaches per-node contracts and
available values for the editor. Callers never recover structure by parsing
messages.

**Deployment.** `validateWorkflowDefinitionIssuesForDeployment` in `schema.ts`
is what a definition must pass before it can run. For a v2 definition it runs,
in one pass: the graph rules of section 4, the per-type configuration schemas,
the block deployment rules from
`apps/worker/src/workflow-definition/block-registry.ts`, the binding analysis
from `available-values.ts`, the Branch condition and Transform reference
checks, the workspace access rules from
`apps/worker/src/workflow-definition/workspace-access.ts`, and the repository
scope pin rules.

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
message set and the error state the run records.

## 12. Storage, versions and deployment state

`apps/worker/src/workflow-definition/store.ts` owns persistence. A definition
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
| Schemas, graph rules, deployment validation | `apps/worker/src/workflow-definition/schema.ts` |
| Candidate validation for the API | `apps/worker/src/workflow-definition/validation.ts` |
| Block catalog, ports, param keys | `packages/contracts/workflow-graph.ts` |
| Block contracts and registry rules | `apps/worker/src/workflow-definition/block-registry.ts` |
| Binding resolution | `apps/worker/src/workflow-definition/v2-bindings.ts` |
| Available values and node contracts | `apps/worker/src/workflow-definition/available-values.ts` |
| Scheduler, loop regions, checkpoints | `apps/worker/src/workflow-definition/v2-scheduler.ts` |
| Execution errors and runtime graph helpers | `apps/worker/src/workflow-definition/interpreter.ts` |
| Harness profile resolution | `apps/worker/src/workflow-definition/harness-profile-runtime.ts` |
| Workspace access rules | `apps/worker/src/workflow-definition/workspace-access.ts` |
| Persistence and versions | `apps/worker/src/workflow-definition/store.ts` |
| MCP authoring tools | `apps/worker/src/mcp/tools/workflow-authoring.ts` |
