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
- `dashboard.tsx`: the screens this integration contributes to the cockpit,
  one component per page the manifest declares, built from
  `@integrations/host-ui`. Delete it and empty `manifest.pages` if your
  integration brings no screens of its own.
- `README.md`: this file. Replace it with your own integration's README. The
  generator refuses a package without one.

## Making it yours

1. Copy this directory to `integrations/<id>`.
2. Rename the package to `@integrations/<id>` in `package.json`.
3. Change the manifest `id` to `<id>`.
4. Rename the block types from `example_*` to `<id>_*`.
5. Rename the connection fields' environment variables from `EXAMPLE_*` to
   `<ID>_*`.
6. Keep `manifest.pages` and `dashboard.tsx` in step, or delete both.
7. Run `pnpm install`.
8. Run `pnpm gen:integrations`.

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
- Every page in `manifest.pages` needs a component of the same id in
  `dashboard.tsx`, and a `dashboard.tsx` with no declared pages is refused.
- `dashboard.tsx` may import `@integrations/host-ui` and your own files. Not
  `@/...`, not `next/*`, not `node:*`, not `server-only`, and it may not read
  `process.env`.
- Keep the `IntegrationRuntimeDefinition<...>` annotation in `worker.ts`.
  Written inline as the second argument of `defineIntegrationRuntime`,
  TypeScript stops typing the health probes' arguments from the manifest and
  they arrive as `any`.
