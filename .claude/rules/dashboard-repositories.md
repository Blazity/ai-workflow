---
paths:
  - "apps/dashboard/app/*/repositories/**"
  - "apps/dashboard/app/*/checks/page.tsx"
  - "apps/dashboard/app/api/repository-catalog/**"
  - "apps/dashboard/lib/repository-catalog/**"
  - "apps/dashboard/components/cockpit/screens/repositories/**"
  - "apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.tsx"
  - "apps/dashboard/components/cockpit/flow-editor/deploy-pin-warning.tsx"
  - "apps/dashboard/next.config.ts"
  - "packages/contracts/repository-catalog.ts"
  - "scripts/gates/no-resurrected-paths.json"
---

# Dashboard repositories

- Keep the catalog list and repository entry server-backed. An entry keeps its
  open tab in `?tab=` while one draft, blockers, and Save bar span the tabs.
  Place:
  `apps/dashboard/app/(cockpit)/repositories/`.
- Allow every role to read the catalog, but gate the enabled switch,
  activation and import dialogs, and entry forms with
  `canManageRepositoryCatalog`; the worker enforces writes. Place:
  `apps/dashboard/app/(cockpit)/repositories/repositories-data.tsx`.
- Save only changed profile fields plus `expectedProfileVersion`; omission means
  unchanged, so one tab must not resend another tab's fields. Do not add a read
  before the write; no-ops mint no version, and conflicts instruct a reload.
  Place:
  `apps/dashboard/lib/repository-catalog/profile.ts` and
  `apps/dashboard/app/(cockpit)/repositories/repository-entry.tsx`. Guard:
  `apps/dashboard/lib/repository-catalog/profile.test.ts` and
  `apps/dashboard/app/(cockpit)/repositories/repository-entry.test.tsx`.
- Keep Description and Rules as markdown through the shared prompt editor.
  Profile and suggestion history use their respective cursors; missing provider
  usage is `unpriced`. Place:
  `apps/dashboard/app/(cockpit)/repositories/repository-entry.tsx` and
  `apps/dashboard/lib/repository-catalog/format.ts`.
- Do not recreate the Repository scripts screen or its deleted paths. `/scripts`
  permanently redirects to `/repositories`, `/checks` forwards there, and the
  deleted files stay listed in `scripts/gates/no-resurrected-paths.json`.
  Guard: `pnpm run gate:resurrected`.
- Build the workflow editor's repository picker from both the catalog and the
  provider directory. Once activated, offer only enabled catalog rows; while
  the bridge is active, offer directory rows and mark catalog-disabled rows as
  still pinnable. Place:
  `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.tsx`.
  Guard:
  `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.test.tsx`.
- Derive pin classifications with `splitPins` and activated-catalog warnings
  with `pinnedRepositoriesNotEnabledSentence`. The picker, scope bar, and deploy
  warning must not invent separate semantics or copy. Place:
  `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.tsx`,
  `apps/dashboard/components/cockpit/flow-editor/deploy-pin-warning.tsx`, and
  `packages/contracts/repository-catalog.ts`. Guard:
  `apps/dashboard/components/cockpit/flow-editor/deploy-pin-warning.matrix.test.tsx`.
- Degrade one failed picker read without inventing facts. Catalog failure means
  unknown enabled state; directory failure after activation means unknown
  provider status; losing both, or the bridge's directory, closes the picker.
  Place:
  `apps/dashboard/components/cockpit/flow-editor/repository-catalog-context.tsx`.
- Keep the suggestion proxy timeout owned by `SUGGEST_TIMEOUT_MS` in
  `apps/dashboard/app/api/repository-catalog/handler.ts`; do not repeat its
  numeric value in guidance. Guard:
  `apps/dashboard/app/api/repository-catalog/handler.test.ts`.
- Register profile drafts in `apps/dashboard/lib/settings/unsaved.ts`, so shell
  navigation, logout, and tab close share discard behavior. Place:
  `apps/dashboard/app/(cockpit)/repositories/repository-entry.tsx`.

History: docs/archive/agent-notes/dashboard.md
