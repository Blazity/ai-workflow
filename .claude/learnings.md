# Learnings

## ioredis import under NodeNext module resolution
- `import IORedis from "ioredis"` does NOT work with `module: "NodeNext"` because ioredis is CJS and TS resolves the default import to the module namespace, not the Redis class.
- Use `import { Redis } from "ioredis"` (named export) instead. This works correctly for both types and construction.
- When mocking in vitest, mock as `{ Redis: vi.fn() }` (not `{ default: vi.fn() }`).

## ioredis version alignment with bullmq
- bullmq bundles its own ioredis dependency. If the project's direct ioredis version differs from bullmq's, TypeScript will see two incompatible Redis types and fail with "Type 'Redis' is not assignable to type 'ConnectionOptions'" errors.
- Solution: pin ioredis to the same version bullmq uses (check `node_modules/bullmq/package.json` dependencies).
