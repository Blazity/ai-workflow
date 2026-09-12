Status: current
Last-verified: 2026-09-12

# apps/dashboard

The dashboard is the Next.js App Router cockpit: it authors workflow
definitions and harness profiles, inspects runs and their steps, shows usage
and cost, and carries the approval, clarification and memory surfaces. It holds
no domain logic of its own. Every write goes to the worker's API, and the
worker is the authority on run state.

Root instructions: [../../AGENTS.md](../../AGENTS.md). Read those first; this
file adds only what is true of the dashboard.

## Run and test

From `apps/dashboard` (workspace packages are consumed as TypeScript source;
the scripts invoke Next, TypeScript and Node directly):

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
| `app/(cockpit)/` | the routed screens: runs, tickets, editor, approvals, cost, evals, health, memory, prompts, harness profiles, settings |
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

## Settings

The Settings screen is `app/(cockpit)/settings/`: `page.tsx` streams
`settings-data.tsx` (the server read), which renders `settings-screen.tsx`. The
pieces under that directory are shared rather than page-local: `setup-overview.tsx`
and `stored-only-notice.tsx` are also mounted by the System health screen, and
`settings-area-panel.tsx` wraps `settings-group-form.tsx` with a key filter for
the Memory panel (`ENABLE_REPO_MEMORY`, `ENABLE_ORG_MEMORY_PROMOTION`,
`ENABLE_REPO_ROUTING_MEMORY`). The Repository scripts screen carries no settings
panel: its own instructions to edit `PRE_PR_CHECKS_ALLOWED_ENV` and redeploy are
the true ones until the consumers stages land, and stage G mounts the Checks
panel once they have.

**A saved value is stored, not applied.** The store and this screen ship before
the stages that rewire the worker's readers, so the worker still reads most keys
from `process.env`. `STORED_ONLY_NOTICE` says so on every surface that shows a
settings value, the badge says where a value is *stored*, the overview labels
the behaviour rows "Stored setting: ...", and nothing here claims a change took
effect. Delete that wording only together with the consumers stage that makes it
false.

Both reads and the write go through `app/api/settings/` (`route.ts` plus
`handler.ts`), which forwards `GET /api/v1/settings`, the `?key=` history read
and `PATCH /api/v1/settings`. The browser calls it through
`apiClient.settings`. Everything derived lives in `lib/settings/` with colocated
`node:test` tests: `groups.ts` panels the entries in registry order, `format.ts`
builds the label, badge, applies-to note, timestamps and the per-key sentences
parsed out of the worker's 400, `patch.ts` turns the form draft back into
registry values (trimming strings, deduping lists) and keeps only the changed
keys plus the refusals the form makes itself, `overview.ts` computes the setup
overview including the secrets row, and `unsaved.ts` is the dirty-form registry.

**Unsaved settings edits use the same guard as the scripts editor, with a set
instead of a boolean.** Up to ten forms are mounted at once, so `unsaved.ts`
keeps the dirty ones and `cockpit-shell.tsx` asks `hasUnsavedSettings()`
alongside `hasUnsavedRepositoryScripts()` before every `router.push`. Each form
installs its own `beforeunload`. There is deliberately no popstate sentinel: one
per dirty form would push up to ten history entries nobody asked for.

Role gating is `canEditSettings` from `@shared/contracts`, applied to
`session.role` in the data components. Reading is open to every role, so the
route and the nav entry are not gated; a member sees every form read only with
the notice, and the worker is what actually refuses the write. A member also
gets a 403 from the system health read, which the Settings page renders as
"Not available" rather than "no scan yet". The `repositories` group renders as a
one-line summary card rather than a form, because activating the catalog is its
own action on the Repositories page and `settings.patch.ts` refuses that group.

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
- **Browser requests use `lib/api/client.ts`.** Raw `fetch` belongs only in that
  browser endpoint client and the server-only transports `lib/api/server.ts`,
  `lib/api/proxy.ts`, and `lib/auth/worker-core.ts`.
- **Block forms have one entry module per catalog type.** Keep block-specific
  form code under `components/cockpit/flow-editor/blocks/`, with shared
  primitives in its support modules and `config-fields.tsx` as the stable
  compatibility facade.
- **`next lint` exists but no gate runs it.** Do not assume lint feedback; the
  gate ladder for both apps is [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md).
- **Editor forms are hand-written per block type.** A new block type needs its
  config fields here as well as its worker-side definition and generated
  catalog entry.

## Where to read next

- What the editor is editing: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Block manifests and the generated catalog: [ADR-002](../../docs/adr/ADR-002-block-manifest.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
