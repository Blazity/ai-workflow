Status: current
Last-verified: 2026-09-11

# packages/AGENTS.md

Workspace packages shared by the worker and the dashboard. `contracts` holds
cross-application shapes and constants; `conditions` evaluates predicates;
`costs` prices provider usage; `prompts` owns prompt composition; and `skills`
owns browser-safe product skill contracts and validation. These pure packages
may import another shared package only through its public entry point and never
application infrastructure. ADR-001 owns the tiers.

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
