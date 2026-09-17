Status: current
Last-verified: 2026-09-17

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

## Area rules

`.claude/rules/` carries what is true of one package only, loaded when a
matching file is read: `workflow-graph` (what may live in the package, its
suites and gates), `contracts-requests` (request body schemas),
`zod-bundle` (the zod the worker bundle really runs),
`worker-settings` (the settings registry).
