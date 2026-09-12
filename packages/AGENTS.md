Status: current
Last-verified: 2026-09-12

# packages/AGENTS.md

Workspace packages shared by the worker and the dashboard. `contracts` holds
cross-application shapes and constants; `conditions` evaluates predicates;
`costs` prices provider usage; `harness` owns model policy and built-in
compatibility profiles; `prompts` owns prompt composition; `skills`
owns browser-safe product skill contracts and validation; and
`workflow-graph` owns the pure rules of a workflow definition. These pure
packages may import another shared package only through its public entry point
and never application infrastructure. ADR-001 owns the tiers.

## The rules that bind

- **Source entry, no build.** `main`, `types` and `exports["."]` all point at
  `index.ts`. There is no `dist`, no `build` script and no `build:shared`
  anywhere. Nitro and Next inline the source into their own bundles.
- **No app imports a package's internals.** Every `exports` map exposes `.`
  only. Import a package through its public entry and add a re-export to its
  `index.ts` instead of deepening an import.
- **Relative specifiers carry no extension.** Write `from "./domain"`, never
  `from "./domain.js"`. Nitro tolerates the `.js` form, webpack does not, and
  the failure appears only in the dashboard build.
- **Inlining relies on pnpm's symlinked node-linker.** The Vercel tracer
  bundles a workspace `.ts` entry because its realpath resolves inside the
  workspace. A hoisted or isolated node-linker would send it looking for a
  `dist` entry that no longer exists.
- **Each package typechecks itself.** A package with no scripts drops silently
  out of `pnpm -r typecheck`, so each keeps a `typecheck` script and a strict
  `tsconfig.json`.
- **Shared dependency versions live in the root catalog.** Anything two
  projects declare goes on `catalog:`, enforced by
  `scripts/gates/check-deps-consistency.mjs`.

## The workflow graph package

`workflow-graph` is the home of the rules that say what a workflow definition
is, how its blocks are scheduled and how values flow between them. Stage 0 of
[the plan](../docs/plans/2026-09-11-workflow-graph-package.md) created it with
`v2-bindings.ts` (reference parsing and resolution, input bindings, prompt data
tokens) and `v2-branch.ts` (branch configuration recognition and evaluation).
Stage 4 added the structural half of the worker's old definition schema:
`schema.ts` (the v2 parser, the deterministic stored-shape upgrade
`normalizeV2AgentProfileConfiguration` performs, the block configuration shapes
the params map is composed from), `graph-issues.ts` (ids, ports, reachability,
cycles, loop and branch shape, per-type parameter parsing, branch and transform
reference compatibility, the two pure schedule reachability rules, the
any-scope review safety check, plus the shared issue factory and
`dedupeWorkflowDefinitionIssues`, the only de-duplication in workflow
validation) and `limits.ts` (`MAX_NODES`, `MAX_EDGES`). Stage 5 added
`policies.ts`, one entry per validation policy: `parse` (read a stored or
submitted graph into the runnable shape and check nothing else; it replaced
`upgradeStoredWorkflowDefinition`), `deploy` (the structural rules plus
everything the running deployment answers, environment availability included)
and `runLoad` (`deploy` without the availability check, for a graph that already
deployed). `deploy` and `runLoad` take the definition `parse` produced rather
than parsing again, which keeps a request to one parse; each composes the
structural rules with the worker-only half, which reaches them through the
injected `WorkflowDeploymentIssueSource`, and de-duplicates the list it
composed. That is one dedupe on top of the one the graph walk already does on
its own list, because `workflowDefinitionStructuralIssues` is a public entry
that has to return a clean list to a direct caller; both use
`dedupeWorkflowDefinitionIssues`. There is no structural-only policy: see the
open decision in the plan's stage 5 bullet. The scheduler
and the interpreter follow in later stages. Source entry is `index.ts`, which
re-exports every module; `exports["."]` is the only public entry, so the worker
imports `@shared/workflow-graph` and never a file inside it.

**Parameters, never environment.** This is the trap that decides whether a rule
belongs here. Everything the rules need from the worker arrives as an argument:
the per-type block parameter schemas (`WorkflowBlockParamsSchemas`, composed in
`apps/worker/src/engine/definition/block-params-schemas.ts`), the block contract
resolver, the available-values catalog, and the Transform shape validator, which
stays in the worker because it checks JSON Schema through ajv. A rule that would
have to read the environment, the block registry, stored state or a clock is not
structural: it belongs in
`apps/worker/src/workflow-definition/deployment-validation.ts`, which composes
both halves. The order the halves compose in is behaviour, because an author
reads one list, and
`apps/worker/src/workflow-definition/__golden__/definition-deployment-issues.json`
pins it byte for byte.

Three more traps. The package may not import worker code, `@shared/harness` or
`@shared/prompts`: `scripts/gates/tiers.json` allows it `contracts` and
`conditions` only, and `scripts/gates/boundaries.mjs` fails on anything else.
It declares only the dependencies it actually imports, because knip fails the
`gate:unused` gate on a declared dependency nothing imports, so zod arrived with
stage 4 and the `@shared/conditions` entry waits for the stage that needs it.
And its vitest suites stay in the worker next to the modules that moved, so a
change here plans them through `WORKFLOW_GRAPH_TESTS` in
`scripts/ci/verify-changed.ts`; a stage that moves another suite's subject adds
that suite to the same list.

## Request schemas live here

`contracts` also owns what the worker's HTTP handlers accept. `requests-*.ts`
holds one runtime zod schema per JSON body a route reads, `request-fields.ts`
the field builders they share, `dashboard-roles.ts` the role vocabulary the
admin bodies check against, and `request-parsing.ts` the seam that runs a schema
over a parsed body: `parseRequestBody` returns a discriminated result rather
than throwing, and `objectOrEmpty` restores the `readBody(...) ?? {}` reading
for the handlers that used to tolerate a body that is not an object. Each schema
answers with the sentence its handler answered with, because moving the check
here must change where a body is refused and not what a client sees.

Two consequences. The package carries a runtime dependency on zod, not a
type-only one, so it is listed in `dependencies` and stays on the root catalog
version. And the tests for these schemas live in the worker, under
`apps/worker/src/routes/request-schemas/`, next to the routes whose behaviour
they pin and inside the only project that runs vitest; the packages here test
with `node:test`, and stage 11 revisits where they belong.
