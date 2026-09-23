Status: current
Last-verified: 2026-09-23

# apps/dashboard

The dashboard is the Next.js App Router cockpit: it authors workflow
definitions and harness profiles, inspects runs and their steps, shows usage
and cost, and carries the approval, clarification and memory surfaces. It holds
no domain logic of its own. Every write goes to the worker's API, and the
worker is the authority on run state.

Root instructions: [../../AGENTS.md](../../AGENTS.md). Read those first; this
file adds only what is true of the dashboard. The visual language and the
shared primitive contract live in [DESIGN.md](../../DESIGN.md).

## Run and test

From `apps/dashboard` (workspace packages are consumed as TypeScript source):

```sh
pnpm run dev        # next dev
pnpm run build      # next build
pnpm run typecheck  # tsc --noEmit
pnpm test           # node --test with tsx over the colocated tests
```

The test runner is the Node test runner with module mocks, not vitest: tests
are colocated (`lib/*.test.ts`, `components/**/*.test.tsx`) and render through
`react-test-renderer`. There is no lint script here: lint is the root
`pnpm run gate:lint` (oxlint), the same gate the worker answers to.

## Directory map

| Directory | What lives there |
|---|---|
| `app/(cockpit)/` | the routed screens: runs, ticket, trace, editor, approvals, checks, cost, memory, prompts, harness profiles (`profiles/`), repositories, integrations (with each integration's contributed pages), settings (with health and users under it) |
| `app/*-data.tsx`, `app/*-skeleton.tsx` | the server components that fetch a screen's data and its loading shape |
| `app/api/` | route handlers that proxy to the worker or serve dashboard-only reads; they share `app/api/worker-forward.ts` |
| `components/cockpit/screens/` | the screen bodies |
| `components/cockpit/agent-visibility/` | what an agent was sent: the Briefing tab of a block attempt, a ticket's Repositories panel and its rounds, the repository map |
| `components/cockpit/flow-editor/` | the definition editor: block palette, config fields, binding fields, branch and loop editors, harness profile picker |
| `components/cockpit/prompt-editor/`, `prompt-library/`, `harness-profiles/` | the authoring surfaces for prompts and profiles |
| `components/ui/` | the canonical primitives, exported from `components/ui/index.ts`; new screens use them |
| `components/ui.tsx`, `charts.tsx`, `flame-graph.tsx` | shared primitives |
| `lib/api/` | the worker client, the proxy, error shaping, fallbacks |
| `lib/settings/`, `lib/repository-catalog/` | the pure helpers behind Settings and Repositories, with colocated tests |
| `lib/agent-visibility/` | reading what the worker serves about briefings and rounds: envelopes, paging, section text cut into parts, the words for recorded values |
| `lib/auth/`, `middleware.ts` | session handling and route protection |
| `lib/*.ts` | pure helpers with colocated tests (run model, run hrefs, live polling, ticket shaping) |

## Area rules

The dashboard's traps live in `.claude/rules/`, loaded when a matching file is
read: `dashboard-ui` (every dashboard file), `dashboard-settings`,
`dashboard-repositories`, `agent-visibility`.

## Where to read next

- What the editor is editing: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Block manifests and the generated catalog: [ADR-002](../../docs/adr/ADR-002-block-manifest.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
