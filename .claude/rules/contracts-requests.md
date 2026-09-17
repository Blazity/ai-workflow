---
paths:
  - "packages/contracts/request*.ts"
  - "packages/contracts/dashboard-roles.ts"
---

# Request contracts

- Keep this request-schema cluster in `packages/contracts/requests-*.ts`, shared
  field builders in `packages/contracts/request-fields.ts`, request parsing in
  `packages/contracts/request-parsing.ts`, and the dashboard role vocabulary in
  `packages/contracts/dashboard-roles.ts`. Export them through
  `packages/contracts/index.ts` so handlers consume one contract.
- Preserve each handler's refusal sentence in its schema. `parseRequestBody`
  returns a discriminated result instead of throwing and uses the first schema
  issue as the client-facing message.
- Wrap a schema with `objectOrEmpty` only when its handler previously treated a
  scalar, array or null body like an empty object. Handlers that explicitly
  rejected non-objects keep an object-level message instead.
- Keep schema tests beside the schemas as `*.test.ts` files run by `node:test`;
  worker route tests own transport behavior. Guard:
  `apps/worker/src/routes/request-body-schema-coverage.test.ts`.
- Follow the zod bundle rule for schema APIs that must work in both bundled
  runtimes.

History: docs/archive/agent-notes/packages-and-adapters.md
