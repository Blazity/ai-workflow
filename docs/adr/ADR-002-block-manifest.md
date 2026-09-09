Status: current
Last-verified: 2026-09-09

# ADR-002: Block manifest

Decision status: Accepted

Source: decision D4 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Measurements cited below come from
[docs/research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md),
sections 3.1 and 3.2; they are not re-measured here.

## Context

A block type is the unit an engineer adds most often, and today adding one
means editing eight places. Audit section 3.1 lists them: the
`WorkflowBlockType` union in `apps/shared/contracts/domain.ts`, `BLOCK_TYPE_SPECS`
in `apps/shared/contracts/workflow-graph.ts`, the registry builder in
`apps/worker/src/workflow-definition/block-registry.ts`, the params schema map
in `apps/worker/src/workflow-definition/schema.ts`, the executor map plus an
inline switch and a missing-executor guard in
`apps/worker/src/workflows/agent.ts`, the executor file itself under
`apps/worker/src/workflows/blocks/`, the dashboard's hand-written form switch
in `apps/dashboard/components/cockpit/flow-editor/config-fields.tsx`, and a
hand-maintained HTML catalog in `docs/workflow-workspace/index.html` that a
test parses with `node:vm` and asserts against the registry.

The cost is measurable in the history: the commit adding the `leak_review`
block touched 24 files in 8 directories, and the commit adding `investigate`
touched 47.

The structural damage is worse than the typing. The params schema map makes
definition validation import every executor, which is the heaviest import cycle
in the repository: `schema.ts` reaches into `workflows/blocks/*`, and those
files pull the runtime with them. Any attempt to separate "what a block is"
from "what a block does" fails while that import exists, because the two
directories cannot be untangled by renaming them.

What the repository already has in its favour: every block file exports its own
`paramsSchema` and its own `execute`. The code is one export short of a
self-describing module.

## Decision

### 1. One directory per block

A block lives in `engine/blocks/<type>/` with exactly two files:

- `manifest.ts`: the type, its params schema, its contract, and its UI hints.
  It has no runtime imports. This is the rule that does the work, and it is
  checkable: a manifest that imports a runtime module fails generation.
- `execute.ts`: the executor.

### 2. Three generated files, from manifests and executors only

A generator writes, and nobody edits by hand:

| Generated file | Built from | Replaces |
|---|---|---|
| `packages/contracts/src/block-catalog.generated.ts` | manifests | the type union and `BLOCK_TYPE_SPECS` |
| `engine/definition/params.generated.ts` | manifests | the params schema map in `schema.ts` |
| `engine/blocks/executors.generated.ts` | `execute.ts` files | `BLOCK_EXECUTORS` in `agent.ts` |

The generator is `scripts/gates/generate-block-catalog.ts`, run as
`pnpm run gen:blocks`, with `gen:blocks --check` proving the generated files
are current. The check runs inside `build`, so a fresh checkout cannot ship a
stale catalog and no contributor has to remember a manual step.

### 3. Definition validation never imports an executor

Because the params schema map is generated from manifests, definition
validation reaches a manifest and stops there. This is what actually removes
the `workflow-definition` to `workflows` cycle, rather than renaming the
directories that hold it.

### 4. The existing catalog test changes meaning

`block-catalog-sync.test.ts` today parses an HTML mock and compares it with the
registry. It becomes the `gen:blocks --check` gate, and the HTML file stops
being a test fixture.

## Consequences

- Adding a block becomes one directory and one pull request: manifest,
  executor, and a regeneration. The dashboard palette reads `BLOCK_TYPE_SPECS`
  from the generated file, so a new block appears in the editor without a
  second edit. The block's form fields stay hand-written; this decision does
  not generate forms.
- The heaviest import cycle in the repository disappears, which is a
  precondition for the tier rules of
  [ADR-001](./ADR-001-layering-and-packages.md) to be enforceable by the
  boundaries gate of [ADR-004](./ADR-004-gates-and-required-ci.md).
- Generated files are checked in. Reviewers see the diff a manifest causes, and
  a fresh clone builds without a generation step.
- A manifest may not import the runtime, so anything a block needs at authoring
  time (schemas, contracts, UI hints) has to be expressible without runtime
  code. A block whose params schema is computed from runtime state has to
  change shape before it can move.
- The move is mechanical but wide: 26 block files change path. It is executed
  in stage 4 of the restructure plan, after the schema v1 retirement of
  [ADR-003](./ADR-003-definition-schema-v1-retirement.md), because both touch
  `blocks/*` and the contracts.

## Options considered

**Keep the eight places and add a test that they agree.** This is what
`block-catalog-sync.test.ts` already is. It catches drift after the fact but
does nothing about the import cycle, and it still costs eight edits per block.

**Generate from the executors instead of from manifests.** Fewer files per
block, but the generator would then have to import runtime modules to read a
schema, which puts the cycle back where it was: the catalog would depend on the
runtime, and the dashboard would transitively depend on it too.

**Move the block files without generating anything.** This was the earlier
shape of the plan. The skeptic pass rejected it: it renames the cycle instead
of removing it, and leaves the dashboard consumer and the fresh-checkout path
untested.
