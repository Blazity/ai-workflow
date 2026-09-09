Status: current
Last-verified: 2026-09-09

# apps/dashboard

The dashboard is the Next.js App Router cockpit: it authors workflow
definitions and harness profiles, inspects runs and their steps, shows usage
and cost, and carries the approval, clarification and memory surfaces. It holds
no domain logic of its own. Every write goes to the worker's API, and the
worker is the authority on run state.

Root instructions: [../../AGENTS.md](../../AGENTS.md). Read those first; this
file adds only what is true of the dashboard.

## Run and test

From `apps/dashboard` (every script starts by building the shared contracts):

```sh
pnpm run dev        # next dev on port 3001
pnpm run build      # next build
pnpm run typecheck  # tsc --noEmit
pnpm test           # node --test with tsx over **/*.test.ts and **/*.test.tsx
pnpm run lint       # next lint, defined but not part of any gate today
```

The test runner is the Node test runner with module mocks, not vitest: tests
are colocated (`lib/*.test.ts`, `components/**/**.test.tsx`) and render through
`react-test-renderer`. The worker's suite is a separate command in a separate
package.

## Directory map

| Directory | What lives there |
|---|---|
| `app/(cockpit)/` | the routed screens: runs, tickets, editor, approvals, cost, evals, health, memory, prompts, harness profiles |
| `app/*-data.tsx`, `app/*-skeleton.tsx` | the server components that fetch a screen's data and its loading shape |
| `app/api/` | route handlers that proxy to the worker or serve dashboard-only reads |
| `components/cockpit/screens/` | the screen bodies |
| `components/cockpit/flow-editor/` | the definition editor: block palette, config fields, binding fields, branch and loop editors, harness profile picker |
| `components/cockpit/prompt-editor/`, `prompt-library/`, `harness-profiles/` | the authoring surfaces for prompts and profiles |
| `components/ui.tsx`, `charts.tsx`, `flame-graph.tsx` | shared primitives |
| `lib/api/` | the worker client, the proxy, error shaping, fallbacks |
| `lib/data/` | the mock dataset a screen falls back to when a source is not configured |
| `lib/auth/`, `middleware.ts` | session handling and route protection |
| `lib/*.ts` | pure helpers with colocated tests (run model, run hrefs, live polling, ticket shaping) |

## Traps specific to this app

- **The worker's store is the authority on run state.** The live overlay is a
  view: when a polled overlay and the stored run disagree, the store wins.
  Making the overlay authoritative is what produced phantom "running" runs.
- **Shared contracts are imported as source, not built.** `@shared/contracts`
  and `@shared/conditions` are workspace packages under `packages/` whose entry
  is `index.ts`, so a type change there is visible here with no build step. Both
  are bundled into this app by Next, which is why their relative specifiers
  carry no `.js` extension: webpack does not remap one onto a `.ts` file.
- **A `1fr` grid track honours its content's min-content.** Wide panels in a
  split view need `minmax(0, 1fr)` on the track and `min-w-0` on the item, or
  the layout blows out and the cockpit shell scrolls sideways.
- **Server and client components are not interchangeable.** Data components
  fetch on the server; anything with state, effects or event handlers is a
  client component. Adding a hook to a data component is the usual way to break
  a build that typechecks locally.
- **`next lint` exists but no gate runs it.** Do not assume lint feedback; the
  gate ladder for both apps is [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md).
- **Editor forms are hand-written per block type.** A new block type needs its
  config fields here as well as its worker-side definition, until the generated
  catalog of [ADR-002](../../docs/adr/ADR-002-block-manifest.md) lands.

## Where to read next

- What the editor is editing: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Block manifests and the generated catalog: [ADR-002](../../docs/adr/ADR-002-block-manifest.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
