---
paths:
  - "apps/dashboard/app/*/settings/**"
  - "apps/dashboard/app/api/settings/**"
  - "apps/dashboard/lib/settings/**"
  - "apps/dashboard/app/*/cockpit-shell.tsx"
  - "apps/dashboard/app/memory-data.tsx"
  - "apps/dashboard/components/cockpit/screens/health.tsx"
  - "apps/dashboard/components/cockpit/screens/memory.tsx"
  - "apps/dashboard/components/cockpit/logout-button.tsx"
  - "packages/contracts/settings-registry.ts"
---

# Dashboard settings

- Treat saved settings as values the worker reads, and never write copy claiming
  that it ignores the store. Show the shared cadence notice and derive each row's
  cadence with `appliesToNote` in
  `apps/dashboard/lib/settings/format.ts`. Guard:
  `apps/dashboard/lib/settings/format.test.ts`.
- Keep the Settings screen registry-driven. Group entries in registry order,
  build PATCH bodies from changed keys only, and keep validation refusals keyed
  to their fields in `apps/dashboard/lib/settings/groups.ts` and
  `apps/dashboard/lib/settings/patch.ts`. Guard:
  `apps/dashboard/lib/settings/groups.test.ts` and
  `apps/dashboard/lib/settings/patch.test.ts`.
- Reuse the Settings components on related screens. System health mounts the
  setup overview and cadence notice, while Memory mounts the group form with its
  own key filter. Place: `apps/dashboard/app/(cockpit)/settings/`,
  `apps/dashboard/components/cockpit/screens/health.tsx`, and
  `apps/dashboard/components/cockpit/screens/memory.tsx`.
- Treat repository activation as catalog state, not a setting. There is no
  repository settings group; the Settings screen reads catalog state and, when
  inactive, links its activation banner to the Repositories page. Place:
  `apps/dashboard/app/(cockpit)/settings/settings-data.tsx` and
  `apps/dashboard/app/(cockpit)/settings/settings-screen.tsx`. Guard:
  `apps/dashboard/app/(cockpit)/settings/settings-screen.test.tsx`.
- Keep entries marked `requiresRedeploy` out of editable forms and render them
  in the read-only Deployment variables section. The shared registry owns that
  marker in `packages/contracts/settings-registry.ts`.
- Proxy settings reads, per-key history, and writes through
  `apps/dashboard/app/api/settings/`; browser callers use
  `apps/dashboard/lib/api/client.ts`, while the worker remains the authority for
  role checks and registry validation. Guard:
  `apps/dashboard/app/api/settings/handler.test.ts`.
- Use one dirty-form registry for every settings form and repository profile
  draft. The cockpit shell and logout action consult
  `apps/dashboard/lib/settings/unsaved.ts`, each form owns its `beforeunload`
  listener, and no per-form popstate sentinel is added. Guard:
  `apps/dashboard/app/(cockpit)/cockpit-shell.test.tsx`.
- Gate editing with `canEditSettings`; every role may read settings, members see
  read-only forms, and the worker enforces writes. Place:
  `apps/dashboard/app/(cockpit)/settings/settings-data.tsx`.

History: docs/archive/agent-notes/dashboard.md
