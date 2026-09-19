# @integrations/host-ui

The UI the dashboard lends an integration.

An integration that declares `pages` in its manifest writes one React component
per page and ships them in `dashboard.tsx` beside `manifest.ts` and `worker.ts`.
Those components import this package and nothing else of ours: `@/components/ui`
is the dashboard's internal alias, it changes whenever a cockpit screen needs it
to, and the boundaries gate refuses it from here.

## Declaring pages

```tsx
// integrations/<id>/dashboard.tsx
import { defineIntegrationDashboard, Page, Card, KeyValue } from "@integrations/host-ui";
import type { manifest } from "./manifest";

function Overview() {
  return (
    <Page title="Overview" description="What this integration is doing here.">
      <Card title="Account">
        <KeyValue items={[{ label: "Workspace", value: "acme" }]} />
      </Card>
    </Page>
  );
}

export const dashboard = defineIntegrationDashboard<typeof manifest>({
  pages: { overview: Overview },
});
```

The type argument is the manifest's type, imported with `import type` so the
manifest's zod schemas never reach the browser. It is what makes a page declared
without a component, and a component for a page nobody declared, a compile
error rather than a tab that renders nothing.

A manifest that declares no pages needs no `dashboard.tsx`. Its area in the
cockpit is the Connection screen alone.

## What a page is handed

`{ integrationId }`. A page shows what its own package knows: there is no
session, no database handle and no worker client in its props, and nothing here
writes anything.

Be clear about what that is. Your page is a Server Component compiled into the
cockpit and run in its process, not code in a sandbox. It could reach
`process.env`, call `fetch`, or pull in any dependency it declares. We treat an
integration as trusted code and review it like our own, and these rules exist so
a page does not end up coupled to our runtime by accident:

- No `next/*`, no `node:*`, no `server-only`, no `@/...`. The boundaries gate
  refuses all four.
- No `process.env`. The registry generator refuses it, in your entry and in
  anything it imports from your package.
- Bound your own fetches. Your page is what the cockpit waits on, and a
  provider that never answers is a tab that never finishes.

If your page needs something this does not give it, that is a contract change.
Say so rather than reaching for it; ADR-010 records where the decision belongs.

## The primitives

`Page`, `Section`, `Card`, `KeyValue`, `Chip`, `Notice`, `EmptyState`,
`ExternalLink`, `Table`.

They are presentational: no state, no effects, no handlers. None of them takes
a `className`. Compose them with your own elements and write Tailwind classes,
arbitrary values included, on those: the dashboard's stylesheet scans the
dashboard entries, so `mt-[13px]` on a page of yours compiles like it would on a
screen we wrote. It scans `dashboard.tsx` and anything under a `dashboard/`
directory beside it, so keep your page code in one of those two places.

Deliberately absent, each for a reason the cockpit has to hold:

| Not here | Why |
|---|---|
| Dialog, overlay, drawer, portal | A page renders inside the content area. Anything that escapes it is an integration taking the screen from the product. |
| Router, internal link, redirect | Where somebody is in the product is the product's to decide. `ExternalLink` leaves to your provider, in a new tab, with `noreferrer noopener`. |
| Inputs, selects, submitting buttons | A page has no write seam in this build. A control that does nothing when clicked is worse than no control. |
| `className` on a primitive | The look of a primitive is the product's. Wrap it; do not redress it. |

## Tokens

Everything here is drawn with the cockpit's own tokens (`DESIGN.md`), so a
palette change reaches an integration's pages the same day it reaches ours. Use
them in your own markup too: `bg-panel`, `bg-app-bg`, `text-neutral-900` down to
`text-neutral-400`, `text-mariner`, `border-neutral-200`, `font-display`,
`font-body`, `font-mono`, `rounded-pill`, `duration-[var(--motion-fast)]`.
Raw hex and literal durations are drift; the cockpit's gates say so about our own
screens and the same is true of yours.

## Client components

None of these is a client component, so a page is server-rendered by default.
A page that needs a handler puts `"use client"` at the top of its own file.
