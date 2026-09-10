Status: current
Last-verified: 2026-09-09

# ADR-003: Definition schema v1 retirement

Decision status: Accepted

Acceptance is conditional on the two counts named under Evidence, Not measured.
As of 2026-09-09, those counts are pending: the owner runs the SQL in ADR-003
section 9 of the recon.

Source: decision D12 and assumption A11 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Measurements cited below come from
[docs/research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md),
section 3.3, and from the production measurement recorded under Evidence; they
are not re-measured here.

## Context

The repository runs two definition schemas at once, and nothing on record says
why. Audit section 3.3 measured the shape: `definition-step.ts` branches on
`schemaVersion === 1` and passes v1 through, while v2 definitions are flattened
down onto the v1 runtime shape; the built-in default definition is still
emitted as `schemaVersion: 1` with a v2 default sitting beside it in the same
file; the store branches per version; and blocks are partitioned into
v1-executable and v2-only through `isV2OnlyBlockType`.

Two live schemas cost more than the branches themselves. Every new block, every
binding change and every validation rule has to be reasoned about twice, an
agent reading the code cannot tell which arm is the real one, and the
documentation described v1 only, which made the wrong arm look authoritative.

The counter-argument to retiring v1 has always been the fear of breaking
something deployed. That is an empirical question, and it has now been
measured.

## Evidence

- Production holds zero deployed and zero draft v1 definitions across its nine
  non-archived definitions, measured through `workflows.get_graph` on
  2026-09-09.
- 2026-09-09, v1 rows in version history: count pending, owner runs the SQL in
  ADR-003 section 9 of the recon.
- 2026-09-09, deployed v1 rows among archived definitions: count pending,
  owner runs the SQL in ADR-003 section 9 of the recon.
- Nothing creates v1 any more. The definition POST route and the templates emit
  v2; the three singular shim routes that served the v1 default were removed.
- The eight scenario snapshots that pin runtime behaviour are v2.

The deleted stall-repro test and fixture are covered by the surviving `apps/worker/workflow-sdk-tests/v2-concurrent.test.ts` coverage.

### Not measured

The production measurement above was taken through `workflows.get_graph`.
Three populations of stored rows sit outside what that read can reach. None of
them has been counted, and the decision below legislates the first two.

- **Archived definitions.** An archived definition is invisible to authoring:
  the MCP read returns `NOT_FOUND` for it
  ([architecture/workflow-definition.md, section 12](../architecture/workflow-definition.md)).
  The count of nine therefore covers non-archived rows by construction, not by
  luck: unarchiving an old definition returns it to the population that has to
  run.
- **Version history.** Every save appends a row to
  `workflow_definition_versions`
  (`apps/worker/src/db/schema.ts:852`), and sections 3 and 4 legislate exactly
  those rows: a stored v1 row stays readable, a rollback to one returns 409,
  the editor hides Restore on it. Not one of them was counted.
- **The Arthur tenant's database.** The tenant still receives releases under
  the contract in [releases/artur/README.md](../releases/artur/README.md), and
  its rows live in a database this measurement never touched.

Stage 3b of
[the restructure plan](../plans/2026-09-09-architecture-restructure.md) opens
by measuring the first two by SQL on production and handing the counts back to
this record:

```sql
-- v1 rows in version history
select count(*) from workflow_definition_versions
where definition->>'schemaVersion' is distinct from '2';

-- deployed v1 rows among archived definitions
select count(*)
from workflow_definitions d
join workflow_definition_versions v
  on v.definition_id = d.id and v.version = d.deployed_version
where d.archived_at is not null
  and v.definition->>'schemaVersion' is distinct from '2';
```

Acceptance is conditional on those counts. The deletions in section 1 do not
land until they are recorded here, and a count that changes what section 3 or
section 4 has to do sends this record back for revision first. The same two
queries, run against the Arthur tenant, are what the release in
[releases/artur/upgrade-preflight.md](../releases/artur/upgrade-preflight.md)
needs before it ships a build with no v1 arm.

## Decision

Schema v1 is retired for everything that runs, deploys or is authored. Stored
history stays readable.

### 1. Deleted

The v1 graph walker (`executeGraph` in `workflow-definition/interpreter.ts`),
every `schemaVersion === 1` branch and every now-constant `schemaVersion === 2`
guard in the workflow body, the steps, the blocks, dispatch, definition
loading, the prompt drift gates and the store, `isV2OnlyBlockType`, the v1 to
v2 converter and migration (worker module, migrate route, dashboard drawer),
the three singular shim routes, and the dashboard's `schemaVersion = 1`
defaults and branches.

`buildRuntimeGraph`, `executionError`, `formatExecutionErrorForUser` and
`createWorkflowExecutionErrorState` stay: the v2 walker uses them.

### 2. Replaced, not deleted

The fresh-install default is a live path, not shim filler. Its five consumers
(`buildDefault` in `definition-step.ts`, the clone and seed fallbacks in
`workflow-definitions.post.ts`, `builtin-prompt-drift.ts` and
`carry-schema-drift.ts`) move to `defaultWorkflowDefinitionV2` first, and only
then is the v1 default deleted.

The zero-definition database keeps the pre-existing `no_definition` dispatch contract; 3b changes the v1 default only where that default already applied: a definition without a deployed graph, clone and seed fallbacks.

The runtime plan shape that `toLegacyRuntimeShape` produces is internal, still
used by the v2 walker, and is kept under the name `toRuntimeShape`.

### 3. Stored v1 rows stay readable

Legacy rows survive as a raw `unknown` value preserved by the discriminator-only
history parser. The runnable `WorkflowDefinition` type is v2, and the
version-history read returns a `v2 | legacy-v1` result so an operator can still
open what was stored.

### 4. What a v1 row can no longer do

- A rollback to a v1 version returns 409 with the retired-schema message.
- The editor hides Restore on a v1 history row, and the clipboard rejects a v1
  payload.
- `workflows.save_draft` with `schemaVersion: 1` returns `VALIDATION_FAILED`
  with that message, and the MCP contract records the changed description.

### 5. A gate keeps it retired

`scripts/gates/single-schema-version.mjs` fails on a reintroduced version
branch, and the shim and migrate route paths are appended to the
resurrected-paths list so a rebase cannot quietly bring them back.

## Consequences

- This is the plan's only deliberate behaviour change. It is executed in stage
  3b, behind a preview deploy and both non-dry canaries, and it opens the
  freeze on `apps/worker/src/workflows`.
- A tenant that still holds a deployed v1 definition would stop running on
  upgrade. Production holds none among its non-archived definitions. The Arthur
  tenant has not been measured (see Not measured above), so the release
  preflight, extended with the `schemaVersion` count, is what has to clear it.
  A tenant in that position has to republish from the editor rather than roll
  back.
- Documentation follows the code: `docs/architecture/workflow-definition.md`
  describes v2 only, and mentions v1 in one sentence that points here.
- The block work of [ADR-002](./ADR-002-block-manifest.md) becomes smaller,
  because there is one arm to move rather than two.

## Options considered

**Keep v1 as a read-only runtime.** Rejected: the cost is not the walker, it is
the branch at every decision point. A read-only runtime keeps every branch
alive while removing the ability to test the arm that keeps them honest.

**Retire v1 in a separate campaign after the restructure.** This was the first
answer, and it was reversed on 2026-09-09 by the owner. Two live schemas make
every intervening stage decide twice, and the measurement shows nothing depends
on the second answer.

**Migrate stored v1 rows to v2 on read.** Rejected: it rewrites history that a
person may need to read exactly as it was stored, and it keeps the converter
alive forever to serve rows nobody runs.
