---
paths:
  - "apps/worker/src/engine/**"
  - "apps/worker/src/harness-profiles/**"
  - "apps/worker/src/infra/runtime-env.ts"
  - "apps/worker/src/mcp/**"
  - "apps/worker/src/post-pr-gate/**"
  - "apps/worker/src/sandbox/**"
  - "apps/worker/src/services/prompts/**"
  - "packages/agent-visibility/**"
  - "packages/contracts/**"
  - "packages/workflow-graph/**"
  - "integrations/**"
---

# Zod in the worker bundle

- Use only Zod APIs common to Zod 3 and Zod 4 in schemas reachable from the
  worker bundle. Nitro traces the Zod 4 dependency of `@workflow/core` recorded
  in `pnpm-lock.yaml`, while the workspace catalog in `pnpm-workspace.yaml`
  pins Zod 3.
- Do not use the one-argument `z.record(valueSchema)` form. Zod 4 reads it as
  `z.record(keySchema, valueSchema)` and can throw `Cannot read properties of
  undefined` when parsing an object with a key.
- Write curated schema errors as `{ message }`. For a union, put the same text
  in both `message` and `errorMap`, because Zod 3 and Zod 4 consume different
  options there.
- Run the compatibility gates after changing these schemas. Guard:
  `pnpm run test:packages:zod4` for the shared packages with a runtime zod
  dependency, every provider integration, the template, the SDK and the
  registry, and
  `pnpm --filter worker run test:zod4` for the MCP tool catalog. Do not treat
  the rest of the worker suite as a Zod 4 gate, because error wording differs;
  the worker alias tests assert refusals rather than exact sentences.

History: docs/archive/agent-notes/worker-runtime.md
