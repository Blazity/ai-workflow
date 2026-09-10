Status: current
Last-verified: 2026-09-09

# Block modules

Each workflow block has one directory under
`apps/worker/src/engine/blocks/<block-name>/`. The directory is the source of
the block catalog and contains a pure `manifest.ts`. A mapped block also has an
`execute.ts` file. Inline blocks keep their run-scoped switch in the workflow
runner and do not need an executor file.

## Manifest contract

The manifest exports one `manifest` object with these fields:

- `type`: the authored workflow block type.
- `paramsSchema`: the zod schema for the block parameters.
- `contract`: category, output ports, and failure-port support.
- `ui`: group, label, description, and glyph.
- `defaults` and `inputs`: the editor defaults and input contracts copied into
  the generated catalog.
- `additionalInputs`: optional dynamic input contracts.
- `execution`: `map` for a generated executor-map entry, `inline` for the
  runner's inline path, or `graph` for blocks executed directly by the graph
  walker.

`manifest.ts` may import only `zod` and types from `@shared/contracts`. It must
not import an executor or runtime code from sandbox, lib, db, adapters,
workflows, or another block module.

## Adding a block

1. Create `apps/worker/src/engine/blocks/<block-name>/manifest.ts`.
2. Add the block type, parameter schema, contract, UI hints, and execution
   kind to the manifest.
3. For a mapped block, add `execute.ts` and export `execute` with the existing
   `BlockExecuteFn` signature. Keep step directives in the executor file.
4. Run `pnpm run gen:blocks -- --check`. It fails because the committed
   generated catalogs are stale, and check mode writes nothing.
5. Run `pnpm run gen:blocks` from the repository root, then run
   `pnpm run gen:blocks -- --check` again. The check passes.
6. If the block is removed, delete its manifest and executor, run
   `pnpm run gen:blocks` again, and run the check once more. It passes with the
   removed block absent from every generated catalog.

The generator writes these committed files:

- `packages/contracts/block-catalog.generated.ts`
- `apps/worker/src/engine/definition/params.generated.ts`
- `apps/worker/src/engine/blocks/executors.generated.ts`

The catalog and parameter map are consumed by both applications. The executor
map is consumed by the worker. Do not edit generated files directly.

## Reviewer walkthrough

The review procedure is to create a temporary fixture block with a pure
manifest and a small mapped executor, run `pnpm run gen:blocks -- --check` and
observe the stale failure, generate the catalogs, inspect the three generated
files, then remove the fixture, regenerate, and run the check again. Stage 4
exercised that procedure with a throwaway fixture and removed it before the
repository verification run.
