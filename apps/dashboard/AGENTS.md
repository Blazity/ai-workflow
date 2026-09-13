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
```

Linting is the root `pnpm run gate:lint` (oxlint over `apps/dashboard` among
others), not a script in this package.

The test runner is the Node test runner with module mocks, not vitest: tests
are colocated (`lib/*.test.ts`, `components/**/**.test.tsx`) and render through
`react-test-renderer`. The worker's suite is a separate command in a separate
package.

## Directory map

| Directory | What lives there |
|---|---|
| `app/(cockpit)/` | the routed screens: runs, tickets, editor, approvals, cost, evals, health, memory, prompts, harness profiles, repositories, settings |
| `app/(cockpit)/repositories/` | the repository catalog: the list with the enabled switch, the activation and import dialogs, and the entry at `[id]` with its five tabs |
| `app/api/repository-catalog/` | the proxy to the worker's catalog routes, including the 100 s suggestion call |
| `app/*-data.tsx`, `app/*-skeleton.tsx` | the server components that fetch a screen's data and its loading shape |
| `app/api/` | route handlers that proxy to the worker or serve dashboard-only reads |
| `components/cockpit/screens/` | the screen bodies |
| `components/cockpit/screens/repositories/` | the script group editor, now bound to one repository's profile instead of a fleet in one blob |
| `components/cockpit/flow-editor/` | the definition editor: block palette, config fields, binding fields, branch and loop editors, harness profile picker |
| `components/cockpit/prompt-editor/`, `prompt-library/`, `harness-profiles/` | the authoring surfaces for prompts and profiles |
| `components/ui.tsx`, `charts.tsx`, `flame-graph.tsx` | shared primitives |
| `lib/api/` | the worker client, the proxy, error shaping, fallbacks |
| `lib/data/` | the mock dataset a screen falls back to when a source is not configured |
| `lib/repository-catalog/` | the catalog's pure helpers with colocated tests: row formatting, the profile draft and its patch, the activation copy, the import summary, the suggestion diff |
| `lib/auth/`, `middleware.ts` | session handling and route protection |
| `lib/*.ts` | pure helpers with colocated tests (run model, run hrefs, live polling, ticket shaping) |

## Settings

The Settings screen is `app/(cockpit)/settings/`: `page.tsx` streams
`settings-data.tsx` (the server read), which renders `settings-screen.tsx`. The
pieces under that directory are shared rather than page-local: `setup-overview.tsx`
and `settings-cadence-notice.tsx` are also mounted by the System health screen, and
`settings-area-panel.tsx` wraps `settings-group-form.tsx` with a key filter for
the Memory panel (`ENABLE_REPO_MEMORY`, `ENABLE_ORG_MEMORY_PROMOTION`,
`ENABLE_REPO_ROUTING_MEMORY`).

**A saved value is stored AND read, at a cadence the row states.** The worker
loads one settings snapshot per request, per cron tick and per MCP call, so what
a form cannot show by itself is when a change reaches work already running:
`SETTINGS_CADENCE_NOTICE` says that on every surface showing a settings value,
`appliesToNote` says "Applies immediately" or "Applies to the next run" per key,
and the badge still says where a value came from. The wording that claimed the
worker ignored the store was false from stage B1 onward; do not bring it back.

**Activation is never read from a settings key.** `catalog.activated` is in the
registry and nothing writes it, so a deployment whose seed activated the catalog
resolved it to the default and the Settings page called an activated catalog
"Not activated". Both the setup overview row and the Repositories summary card
take `catalogState` (the `state` the catalog list route returns, the same read
the Repositories page makes) and say who activated it and when. Its removal from
the registry is a worker and contracts change.

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

**Unsaved edits are one registry, shared.** Up to ten forms are mounted at once,
so `lib/settings/unsaved.ts` keeps the dirty ones by key and `cockpit-shell.tsx`
asks `hasUnsavedSettings()` before every `router.push`; the repository entry
registers its own draft there, so one guard and one `DISCARD_UNSAVED_PROMPT`
cover both surfaces. Each form installs its own `beforeunload`. There is deliberately no popstate sentinel: one
per dirty form would push up to ten history entries nobody asked for.

Role gating is `canEditSettings` from `@shared/contracts`, applied to
`session.role` in the data components. Reading is open to every role, so the
route and the nav entry are not gated; a member sees every form read only with
the notice, and the worker is what actually refuses the write. A member also
gets a 403 from the system health read, which the Settings page renders as
"Not available" rather than "no scan yet". The `repositories` group renders as a
one-line summary card rather than a form, because activating the catalog is its
own action on the Repositories page and `settings.patch.ts` refuses that group.

## Repositories

`app/(cockpit)/repositories/` is the repository catalog: `page.tsx` streams
`repositories-data.tsx` (the catalog read), which renders `repositories-screen.tsx`
with the enabled switch, the not-activated banner and the activation and import
dialogs. `[id]/` is one repository, with five tabs (Overview, Rules, Scripts,
Memory, History) over one Save bar; the open tab lives in `?tab=`, so a tab is
linkable and a reload comes back to it: a tab reports its blocker upward, the page
holds the draft and the reason, and one `PUT /api/v1/repository-catalog/:id`
sends ONLY the fields that changed plus `expectedProfileVersion`. An omitted
field means unchanged on the route, so a Rules save never carries the script
groups; a save that changes nothing answers `unchanged: true` and mints no
version; a profile that moved since the screen loaded answers 409
`repository_profile_conflict` with the version it sits at, which is why the
screen no longer reads the row before writing it. Rules and Description use
`components/cockpit/prompt-editor/prompt-editor.tsx` and still store markdown.
The History tab pages the profile versions (`?limit=&before=`, `hasMore` on the
response, "Load more" under the list) and, under them, the suggestion calls
from `app/api/repository-catalog/[id]/suggestions/`, cursor paginated, where a
call the provider reported no usage for reads `unpriced`.

**`/scripts` and `/checks` both forward here.** The Repository scripts screen is
gone: its editor lives at `components/cockpit/screens/repositories/script-groups.tsx`
bound to one repository, `next.config.ts` holds a permanent redirect from
`/scripts` to `/repositories`, `app/(cockpit)/checks/page.tsx` redirects the
older path, and `scripts/gates/no-resurrected-paths.json` names the deleted
files so a rebase cannot bring them back. Every editor panel that linked to
`/scripts` links to `/repositories`.

**The editor's repository picker reads the catalog, not the directory alone.**
`components/cockpit/flow-editor/repository-catalog-context.tsx` reads both
`/api/repository-catalog` and `/api/repositories`: activated, only the rows the
catalog enables can be pinned and only those are offered; while the bridge is on
the directory is the list and a row the catalog does not enable is shown,
marked, and still pinnable, because dispatch accepts it today. A pin the catalog
does not enable is named with the sentence `workflows.publish` announces, copied
rather than reworded, in the picker, on the scope bar and beside Deploy
(`deploy-pin-warning.tsx`); `splitPins` in the context is the one place the two
cases are told apart, so the three surfaces cannot drift.

**Losing one read degrades the picker; losing both closes it.** The catalog
failing falls back to the directory with "repository catalog unavailable,
enabled state unknown"; the directory failing keeps the catalog's rows but
reports every provider as `error` carrying "provider directory unavailable,
connection state unknown", because rows name which providers exist and nothing
about their health. The exception is the bridge with no directory: the directory
IS the list then, so that is an error rather than an empty list called ready.

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
- **There is no per-app lint script.** Lint feedback comes from the root
  `pnpm run gate:lint` (oxlint), the same gate the worker answers to; the gate
  ladder for both apps is [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md).
- **Editor forms are hand-written per block type.** A new block type needs its
  config fields here as well as its worker-side definition and generated
  catalog entry.

## Where to read next

- What the editor is editing: [docs/architecture/workflow-definition.md](../../docs/architecture/workflow-definition.md)
- Block manifests and the generated catalog: [ADR-002](../../docs/adr/ADR-002-block-manifest.md)
- Gates and CI: [ADR-004](../../docs/adr/ADR-004-gates-and-required-ci.md)
- Environment variables and deployment: [SETUP.md](../../SETUP.md)
- Everything else that is current: [docs/index.md](../../docs/index.md)
