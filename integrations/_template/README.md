# Example integration

This directory is copied, not edited in place. It is the skeleton for a new
integration under `integrations/<id>`.

## Files

- `manifest.ts`: plain data. Identity, connection fields, capabilities,
  blocks, pages, health checks. Read by core, the dashboard and the Workflow
  DevKit's flow bundle without running any of your code, so it imports only
  `@integrations/sdk`.
- `worker.ts`: the code behind the manifest. A connection test, one adapter
  per declared capability, one executor per declared block, one probe per
  declared health check. Server only; it may import `@integrations/sdk` and
  `./manifest`.
- `README.md`: this file. Replace it with your own integration's README. The
  generator refuses a package without one.

## Making it yours

1. Copy this directory to `integrations/<id>`.
2. Rename the package to `@integrations/<id>` in `package.json`.
3. Change the manifest `id` to `<id>`.
4. Rename the block types from `example_*` to `<id>_*`.
5. Rename the connection fields' environment variables from `EXAMPLE_*` to
   `<ID>_*`.
6. Run `pnpm install`.
7. Run `pnpm gen:integrations`.

## What will get your package refused

- `manifest.ts` may import only `@integrations/sdk`. No Node module, no
  relative import outside the package.
- No `"use step"` directive anywhere in an integration.
- An id core already uses (see `RESERVED_INTEGRATION_IDS` in
  `@integrations/sdk`) is refused.
- Every block the manifest declares needs an executor in `worker.ts`, and
  every capability the manifest declares needs an adapter factory.
- A block type another integration or a core block already owns is refused; a
  block type must start with `<id>_`.
- The package name must be `@integrations/<id>`, matching the manifest id.
- Keep the `IntegrationRuntimeDefinition<...>` annotation in `worker.ts`.
  Written inline as the second argument of `defineIntegrationRuntime`,
  TypeScript stops typing the health probes' arguments from the manifest and
  they arrive as `any`.
