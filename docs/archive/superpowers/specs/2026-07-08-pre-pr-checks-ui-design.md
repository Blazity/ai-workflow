# UI-Configurable Pre-PR Checks — Design

Date: 2026-07-08
Status: Approved

## Context

The pre-PR check gate (PR #113, `apps/worker/src/pre-pr-checks/`) runs per-repository sandbox
commands after the agent phases and before branch push / PR creation, with up to 3 agent fix
cycles. Today it is configured through a single JSON env var (`PRE_PR_CHECKS`), which has three
problems: editing requires a redeploy, malformed JSON is only discovered at gate time (after the
expensive agent phases), and a `repoPath` typo silently disables checks for that repository.

This design moves the configuration into Postgres with a dashboard editor.

## Decisions (settled with Karol, 2026-07-08)

1. **DB only — the `PRE_PR_CHECKS` env var is retired.** No env fallback. The feature merged a day
   before this design, so nothing depends on the env var yet.
2. **Structured editor with a repository picker**, not a raw JSON editor. The picker is fed by the
   worker's existing repository-directory adapter so operators choose from repositories the
   GitHub App / GitLab token can actually reach.
3. **Admins and owners edit; members view read-only.** Same tier as inviting users.
4. **Full version history with rollback**, modeled as an append-only versions table
   (approach A — chosen over current-row-plus-history and over a generic settings table).

## Data model

New table in `apps/worker/src/db/schema.ts`:

```
pre_pr_check_config_versions
  version                serial PRIMARY KEY      -- monotonic; current = MAX(version)
  config                 jsonb NOT NULL          -- $type<PrePrCheckConfig>
  created_at             timestamp NOT NULL DEFAULT now()
  created_by_id          text NOT NULL           -- dashboard user id
  created_by_label       text NOT NULL           -- name/email snapshot (survives user deletion)
  restored_from_version  integer                 -- set when this save is a rollback
```

- Every save appends a row. Rollback appends a copy of an older version's `config` with
  `restored_from_version` set — history stays linear and immutable.
- No rows ⇒ gate disabled (equivalent to today's unset env var).
- `PrePrCheckConfig` / `PrePrCheckRepositoryConfig` types and the strict zod schema stay in
  `apps/worker/src/pre-pr-checks/config.ts` (schema exported for reuse by the write endpoint).
- Migration generated with `pnpm db:generate` (next file in `apps/worker/drizzle/`).

## Shared contracts

Add to `apps/shared/contracts/`:

- `domain.ts`: `PrePrCheckRepositoryConfig`, `PrePrCheckConfig`,
  `PrePrCheckConfigVersion { version, config, createdAt, createdById, createdByLabel,
  restoredFromVersion }`, `RepositoryOption { provider, repoPath, name, owner, defaultBranch,
  private, archived }`.
- `api.ts`: `PrePrChecksResponse { current: PrePrCheckConfigVersion | null,
  versions: PrePrCheckConfigVersion[] }`, `RepositoriesResponse { repositories:
  RepositoryOption[] }`.

## Worker API

All under `/api/v1` (session-gated by the existing `api-auth` middleware). Writes additionally
require admin/owner via a new `canEditPrePrChecks(role)` helper in `lib/auth/roles.ts` (owner or
admin — same tier as `canInvite`), enforced inside the store functions and surfaced as 403.

| Route | Behavior |
|---|---|
| `GET /api/v1/pre-pr-checks` | Current config + version history (most recent 50, full configs — they are small) |
| `PUT /api/v1/pre-pr-checks` | Body `{ config }`; validated with the existing zod schema; appends a version; returns it. 400 with the formatted zod issue list on invalid config |
| `POST /api/v1/pre-pr-checks/restore` | Body `{ version }`; appends a copy with `restored_from_version`; 404 for unknown versions |
| `GET /api/v1/repositories` | Lists accessible repositories via the existing `repository-directory` adapter across configured providers; short in-memory TTL cache (~60s) to spare VCS API rate limits |

Implementation shape mirrors `users/[userId]/role.patch.ts`: `requireDashboardActor` →
testable domain functions in a new `apps/worker/src/pre-pr-checks/store.ts`
(`getCurrentPrePrCheckConfig` — returns `{ version, config } | null`,
`listPrePrCheckConfigVersions`, `savePrePrCheckConfig`, `restorePrePrCheckConfig`) → typed
errors via `DashboardAuthError` / `createError`.

`GET /api/v1/session` additionally gains `canEditChecks: canEditPrePrChecks(actor.role)`,
following the existing `canManageUsers` capability-flag pattern; the dashboard keys its
read-only mode off this flag.

## Workflow read path

`runPrePrChecksStep` in `apps/worker/src/workflows/agent.ts` changes one line:
`parsePrePrCheckConfig(env.PRE_PR_CHECKS)` → `getCurrentPrePrCheckConfig(getDb())` (using its
`config`, treating `null` as the empty config), and logs the version used
(`pre_pr_checks_config_version`). The runner
(`pre-pr-checks/runner.ts`) is untouched — it already takes a typed `PrePrCheckConfig`.

Config is read at gate time (a mid-run save affects runs whose gate hasn't executed yet —
acceptable). Because every save is validated at write time, malformed config can no longer fail a
run; only infra errors can, and those follow the existing step-failure path. This closes the
"late validation" finding from the PR #113 review.

## Env retirement

- Remove `PRE_PR_CHECKS` from `apps/worker/env.ts`, `apps/worker/.env.example`, and SETUP.md.
- Delete the raw-string parser `parsePrePrCheckConfig` and its tests; keep and export the zod
  schema for API-body validation.
- Update README (step-table row and the `PRE_PR_CHECKS` label in the flow diagram) and
  `docs/SPEC.md` (Sections 6, 9.3, 18.1) to describe dashboard-managed config in the same PR.

## Dashboard UI

New cockpit nav entry **"Pre-PR checks"** (`chrome.tsx`, `flow` group) → `app/(cockpit)/checks/`
with a `checks-data.tsx` server fetch for initial data. The screen
(`components/cockpit/screens/pre-pr-checks.tsx`, client component) copies the `users.tsx`
patterns — local modal/button primitives, plain `fetch` to BFF routes, `busyId` in-flight
disabling, `InlineError`, `readErrorMessage`.

Layout:

- One card per configured repository: provider badge + `repoPath`, an editable ordered list of
  command inputs (add/remove), remove-repository control.
- **Add repository**: dropdown lazily fetched from `GET /api/repositories`; already-configured
  repos disabled; manual-entry fallback (provider select + text path) if the directory fetch
  fails.
- **Save**: client-side checks mirroring the zod rules (≥1 command per repo, non-empty strings),
  PUT via BFF, unsaved-changes indicator.
- **History panel**: version rows ("v7 · karol · 2h ago · restored from v3") with per-version
  Restore behind a confirm modal.
- Members (read-only): editing controls hidden/disabled client-side via the session
  `canEditChecks` flag; the server enforces regardless.

BFF routes (thin `proxyWorker` wrappers, mirroring `app/api/users/.../route.ts`):
`app/api/pre-pr-checks/route.ts` (GET, PUT), `app/api/pre-pr-checks/restore/route.ts` (POST),
`app/api/repositories/route.ts` (GET).

## Error handling

- Invalid config on save → 400 with per-field zod issues, rendered inline in the editor.
- Non-admin write → 403 (server-enforced; UI hides controls).
- Restore of unknown version → 404.
- Concurrent edits → last-write-wins append; nothing is lost since both saves land in history.
- Repository directory unavailable → picker falls back to manual entry; saving is unaffected.
- Gate with no config rows → skipped, same summary text as today's unconfigured state.

## Testing

- **Store** (`store.test.ts`, pglite like existing db tests): append/current/list ordering,
  restore appends with marker, role gate, empty state.
- **Worker routes**: mirror `invites.test.ts` — 401/403, 400 invalid config, happy paths for
  save/restore/list, repositories endpoint with a stubbed directory.
- **BFF handlers**: mirror `users/[userId]/role/route.test.ts` with an injected proxy.
- **Workflow**: existing runner tests unchanged; the step's DB read covered by store tests.

## Out of scope

- Per-command timeouts and making the fix-cycle count (3) configurable.
- Startup-time validation concerns (obsoleted by write-time validation).
- A generic settings framework (revisit if a second UI-configurable setting appears).
- Per-branch or per-ticket check overrides.
