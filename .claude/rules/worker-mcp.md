---
paths:
  - "apps/worker/src/mcp/**"
  - "apps/worker/src/services/mcp/**"
  - "apps/worker/scripts/generate-mcp-contract.ts"
---

# Worker MCP

- Load the request settings snapshot before `requireMcpActor` because the MCP enable switch and request-size bound are checked first. Pass that snapshot as `deps.settings`; this is the deliberate authentication-order exception in `apps/worker/src/mcp/transport.ts`, while signed public webhooks defer settings loading until after signature verification.
- Keep repository catalog access lazy and request-scoped. `McpToolDependencies` carries `loadRepositoryCatalog`, not a catalog value; `apps/worker/src/mcp/transport.ts` supplies the event-memoized thunk so tools that need access decisions share one snapshot without making unrelated calls depend on the catalog.
- Regenerate the committed MCP contract after changing a tool with `pnpm --filter worker run mcp:contract:generate`. Guard: `pnpm --filter worker run mcp:contract:check` verifies `apps/worker/src/mcp/contracts/mcp-contract.json` against the live catalog.
- Run `pnpm --filter worker run test:zod4` after changing the MCP tool catalog or its schemas. This is the worker's deployed-runtime schema compatibility gate.

History: docs/archive/agent-notes/worker-settings-and-catalog.md
