Status: current
Last-verified: 2026-09-12

# Repository catalog: QA matrix (epic AIW-338, stages A..M + W)

143 scenarios mapping the repository catalog feature, and for each one the
automated test that holds it, or nothing.

**Provenance.** Recorded as read-only research on `main` at SHA
`e97046d17535a7df396f5b2fa03232942a841896`, then brought into `docs/` when
stage T wrote tests for the rows nobody had pinned. The research pass ran no
test and no build, so a cell naming a test it did not add is still a **claim
that the test exists, not a claim about its result**.

**What stage T changed.** Every cell naming a `*.matrix.test.ts` file was
written by stage T and those tests were run and passed. Four rows turned out to
behave differently from what the research pass expected, and each is pinned as
the CODE behaves, with the cell saying so:

- **P22, P23**, an empty `gateGroups` array and a reference no group answers
  are **accepted** by the profile route. The refusal exists one tier down, in
  the engine's own `repoScriptsConfigSchema`, so what a save buys is a
  repository whose checks fail at run time rather than a 400 at the screen.
- **R03**, the drain-then-disabled sequence was already covered, at
  `apps/worker/src/services/dispatch/dispatch-trigger.test.ts:499`. The row's
  `MISSING` was wrong.
- **M14**, `repositories.import_preview` is **not** open to every role the way
  its HTTP twin is: it keeps the write's scope and role list, deliberately
  (`DEPLOYMENT_PREVIEW_POLICY`, `apps/worker/src/mcp/policy.ts`).

**What the dashboard tests cannot prove.** `apps/dashboard` runs on plain Node
with `react-test-renderer`: no DOM, no layout, no viewport, no focus. The U15
rows assert what the markup COMMITS to (no width pinned above 390 px, the
containers told to wrap, the actions present) and the U14 row asserts the
dialog's declared semantics. Neither measures anything, and neither replaces a
look at a real browser at 390 px.

## Summary

| Section | Rows | Coverage gaps (MISSING or partial) | High risk |
|---|---|---|---|
| 1. Catalog lifecycle | 25 | 6 | 4 |
| 2. Profile authoring | 35 | 14 | 2 |
| 3. Suggestions | 18 | 3 | 0 |
| 4. Runs and the catalog | 23 | 8 | 4 |
| 5. Settings interplay | 10 | 2 | 0 |
| 6. MCP parity and auth | 17 | 4 | 1 |
| 7. UI states | 15 | 6 | 0 |
| **Total** | **143** | **43** | **11** |

Contradictions found: **10**. Open product questions: **11**. Anti-regression gate proposals: section 8.

Two facts that colour the whole matrix:

- **There is no e2e coverage of the catalog at all.** `apps/worker/e2e/` holds `harness-profiles/`, `helpers/`, `replay/`, `scripts/`, `tier2/`; `rg -l 'repository-catalog|catalog' apps/worker/e2e/` returns nothing, and a full sweep of `apps/worker/e2e/**/*.ts` found only false positives (a `/Type/Catalog` literal inside a PDF fixture in `tier2/us02-attachments.test.ts`). Every "run reaches production" row below is MISSING by construction.
- **Unit and route coverage is unusually dense.** `apps/worker/src/mcp/tools/repositories.test.ts` (1295 lines), `repository-catalog.test.ts` (549), `suggest.test.ts` (19 KB), the four dashboard screen tests. The gaps are concentrated in seams: HTTP-vs-MCP divergence, the activation guard, the entry screen's URL state, and anything that needs a live provider.

Legend for the `automated test` column: `file:line` names the test that holds
the row; `MISSING` means no automated test asserts this behaviour anywhere.
A `*.matrix.test.ts` path is a test stage T added for this matrix and ran; every
other path is a pre-existing test the research pass located and did not run.
The summary counts above are the research pass's and have NOT been restated for
what stage T added: read the cells, not the totals.

Rows still MISSING after stage T fall in three groups. A parallel lane (stage F)
owns L18, L25, P24, P31, P34, P29, P30, M13, S17, U08, R04 and R05, because each
of them changes behaviour before it can be pinned. The e2e scenario in section 8
is unwritten. Everything else left as `MISSING` is a row the research pass
scoped out.

---

## 1. Catalog lifecycle

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| L01 | Bridge on a deployment that never activated | `repository_catalog_state.activated = false`, any number of rows | UI: open `/repositories` | Banner "Catalog not activated: the agent sees everything the installation sees." plus an Activate button for owner/admin (`activation.ts:173-174`, `repositories-screen.tsx:185-199`); every repository still dispatches (`policy.ts:33-39`) | Screenshot of the banner; `GET /api/v1/repository-catalog` body showing `state.bridge: true` | `repository-catalog.test.ts:155`; `store.test.ts:71`; `policy.test.ts:25` | med |
| L02 | Bridge with an EMPTY catalog | zero rows, `activated=false` | UI: `/repositories` | Empty state "The catalog is empty. Import the repositories this installation exposes, then enable the ones the agent may touch." + Import button (`repositories-screen.tsx:234-249`); dispatch still passes everything | Screenshot; a dispatched run on a repository with no row | `repositories-screen.test.tsx:97`; `policy.test.ts:32` | med |
| L03 | Bridge, viewer role | `activated=false`, session role `member` | UI: `/repositories` | Banner says "Ask an owner or admin to activate it."; no Import button, no switch (`repositories-screen.tsx:142-160`) | Screenshot as member | `repositories-screen.test.tsx:111`, `:142`, `:155` | low |
| L04 | Import preview lists the installation | provider credentials configured, catalog holds `github:acme/web` | UI: Import from provider. MCP: `repositories.import_preview` `{}` | Every exposed repository listed; `acme/web` marked `inCatalog` and shown disabled with "already in the catalog, importing does not enable it; use the switch" | Preview JSON; screenshot of the greyed row | `repository-catalog-import-suggest.test.ts:164`; `import.test.ts:62` | low |
| L05 | Import preview marks case differences as present | catalog holds `github:Acme/Web`; provider exposes `acme/web` | as L04 | Marked `inCatalog`, the key is lower-cased (`import.ts:113`, `repositoryCatalogKey` at `packages/contracts/repository-catalog.ts:249-253`) | Preview JSON row | `import.test.ts:62`; `repository-catalog.test.ts:243` (contracts) | low |
| L06 | Import commit creates rows disabled by default | provider lists 3 unknown repositories | UI: tick 3, leave "Let the agent touch these repositories" off, Import. MCP: `repositories.import {repositoryKeys:[...], idempotencyKey}` | 3 rows created with `enabled=false`, `source="imported"`, `current_profile_version=0`, the provider's own casing stored (`import.ts:168`; `db/.../repository-catalog.ts:1187`, `:1232-1234`) | Import summary naming all three buckets; row list | `import.test.ts:88`; `repository-catalog-import-suggest.test.ts:183` | low |
| L07 | Import commit enabled, one decision for the whole selection | as L06 | tick the enable checkbox | All 3 rows enabled; the copy states it is one choice for the whole selection | Summary; DB rows | `import.test.ts:110` | low |
| L08 | Import of a path the installation no longer exposes | submit a key that was in a stale preview | MCP: `repositories.import` with that key | Key comes back in `skipped`, nothing created, no error (`import.ts:154-156`) | Response buckets | `import.test.ts:122`, `:134` | med |
| L09 | Import of a path the token cannot see | provider lists successfully but omits a private repository | as L08 | Also `skipped`, indistinguishable from "deleted" (`import.ts:154-156`). See Open question O3 | Response; provider listing captured alongside | `import.test.ts:122` (does not distinguish) | **high** |
| L10 | Import when a provider listing failed entirely | GitLab token revoked, a selected key is GitLab | UI: Import; MCP: `repositories.import` | Whole call refused 503 `provider_unavailable` / MCP `DEPENDENCY_UNAVAILABLE`, nothing written (`import.ts:122-136`; `tools/repositories.ts:153-163`) | 503 body; empty diff on the rows | `import.test.ts:153`; `repository-catalog-import-suggest.test.ts:200`; `repositories.test.ts:1034` | med |
| L11 | Import when the failing provider owns none of the selected keys | GitLab down, only GitHub keys selected | as L10 | Import proceeds (`import.ts:122-136` only blocks the providers actually named) | Response; row list | `import.test.ts:178` | low |
| L12 | Import twice, same selection | run L06 twice | repeat the import | Second call creates nothing, reports `alreadyPresent`, and does NOT re-enable a row somebody switched off (`ON CONFLICT DO NOTHING`, `repository-catalog.ts:1187`) | Both responses; `enabled` unchanged | `import.test.ts:196` | med |
| L13 | Import fills the default branch | rows created with `default_branch=''` | after L06, inspect the rows | `backfillConnectedRepositoryDefaultBranches` fills only empty values, best-effort, never overwrites a recorded one (`import.ts:187-193`; `repository-catalog.ts:1294-1326`) | Rows before/after; the backfill is `.catch(() => 0)` so a failure is silent | `apps/worker/src/services/repository-catalog/import.matrix.test.ts:120` (fills only empty), `:146` (the silent failure) | med |
| L14 | Activation preview, dashboard | catalog activated=false, 2 enabled, 3 disabled, one disabled repository holds a live run claim | UI: Activate | Dialog states both populations, lists what stops passing, and the provider-directory count outside the catalog; reason field required | Screenshot; the 409 body once it fires | `activate-dialog.test.tsx:117`, `:160`, `:180` | med |
| L15 | Activation preview, MCP | as L14 | `repositories.activate_preview {}` | `keeping`, `stopping`, `claimed` (with ticket keys and run ids) plus `previewDigest`; it does NOT count repositories outside the catalog and says so (`tool-catalog.ts:663`; `activation-preview.ts:21-26`) | Tool response | `repositories.test.ts:748` | low |
| L16 | Activation refused because a claimed repository was not acknowledged | a disabled repository has a live claim | UI: Activate without expanding the claim list; HTTP: `POST /api/v1/repository-catalog/activate` with `acknowledgedRepositoryKeys: []` | 409 `unacknowledged_repositories` with `[{key, displayName, ticketKeys, runIds}]`, nothing written (`activate.post.ts:50-56`; `authoring.ts:298-301`) | 409 body; state row unchanged | `repository-catalog.test.ts:365`; `repository-catalog.test.ts:253` (db) | med |
| L17 | Activation with an empty reason | any | HTTP: activate with `reason: ""` | 400 "a reason is required" (`repository-catalog-api.ts:186-204`) | 400 body | `repository-catalog.test.ts:360` | low |
| L18 | **Activation with ZERO enabled repositories, through HTTP** | catalog activated=false, every row disabled | `curl -X POST /api/v1/repository-catalog/activate -d '{"reason":"x"}'` with an owner session, bypassing the dialog | **Today: it activates.** The "enable at least one first" refusal lives only in `apps/dashboard/lib/repository-catalog/activation.ts:110-111` and `apps/worker/src/mcp/tools/repositories.ts:556`; `activateRepositoryCatalog` (`authoring.ts:286-320`) and `activate.post.ts:30-62` have no such check. Every subsequent dispatch is then refused. See Contradiction C1 | The 200 response; the next webhook delivery recorded `ignored_repository_not_enabled` | MISSING on the HTTP path (`activate-dialog.test.tsx:150` and `repositories.test.ts:821` cover the other two surfaces only) | **high** |
| L19 | Re-activation of an already activated catalog | `activated=true` | HTTP activate again with a new reason | The state row is overwritten (`onConflictDoUpdate`, `repository-catalog.ts:862-898`): actor, timestamp and reason are replaced, and the previous activation record is lost. MCP reports it instead of pretending it was off | State row before/after | `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:157` | med |
| L20 | Activation banner after activation | `activated=true` by a person | UI: `/repositories` | Banner names who ended the bridge, when and why, plus " Dispatch selects only the repositories enabled here." (`repositories-screen.tsx:201-206`) | Screenshot | `repositories-screen.test.tsx:181`, `:313` | low |
| L21 | Historical activation provenance remains readable | catalog state carries an old automation actor label | open `/repositories` | The banner renders the stored actor and timestamp as historical provenance; no current build path rewrites activation | Screenshot of the stored provenance | `repositories-screen.test.tsx:294`; `packages/contracts/repository-catalog.test.ts:135` | low |
| L22 | Retired settings variable refuses the build | set `COLUMN_AI=x` | run `pnpm --filter worker run build:ci` | Build fails before validation or compilation, names `COLUMN_AI`, and points to the SETUP.md removal section | Build log | `apps/worker/src/services/settings/retired-environment.test.ts`; required H2 build probe | **high** |
| L23 | Legacy repository allowlist is tolerated but unused | set `AGENT_ALLOWED_REPOS` | run the worker and inspect repository access | Boot succeeds; no row or activation changes; the Repositories page remains the only access-control surface | Startup log and unchanged catalog state | consumers guard plus repository catalog policy tests | low |
| L24 | Enable/disable one row | activated catalog, 2 enabled | UI: flip the switch. MCP: `repositories.set_enabled` | Row flips, NO profile version minted (`enabled.patch.ts:29-31`; `repository-catalog.ts:147` db test); MCP reply carries `enabledRemaining` | Row list; version count unchanged | `repository-catalog.test.ts:308`; `repositories.test.ts:667`; db `:147` | low |
| L25 | Disable the LAST enabled repository | activated catalog, exactly 1 enabled | UI: flip it off | MCP answers `enabledRemaining: 0`; **the dashboard shows no such warning**, only the standing line "Disabling stops the next run. A run already in flight keeps the list it started with; cancel it to stop it." Every next run then fails. See Contradiction C2 | Screenshot of the row after the flip; the next dispatch's recorded result | `repositories.test.ts:686` (MCP only); MISSING for the dashboard | **high** |

## 2. Profile authoring

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| P01 | Create a repository from the entry screen | catalog holds nothing at this path | UI: entry with id 0; HTTP `PUT /api/v1/repository-catalog/0` with `provider`,`path`,`description` | Row created **disabled** (`enabled` defaults false, `authoring.ts:173`), profile version 1, `source="manual"` (`repository-catalog.ts:382`) | Response `{repository, version, changedFields}`; row | `repository-catalog.test.ts:191`; db `:358` | low |
| P02 | Create an ENABLED repository | as P01 | send `enabled: true` | Row created enabled | Row | `repository-catalog.test.ts:208`; db `:374` | low |
| P03 | `enabled` on an EXISTING repository is silently ignored | row exists, disabled | `PUT .../:id` with `enabled: true` and a description change | The description saves; **the switch does not move and nothing says so** (`repository-catalog.ts:271-279`, MCP description at `tool-catalog.ts:612`). See Open question O5 | Response; the row still disabled | `repository-catalog.test.ts:222` ("never revokes a grant"); db `:358`; MISSING for the "no feedback" half | med |
| P04 | Omitted field means unchanged | profile has description, rules, scriptGroups | save only `rules` | Description and scriptGroups carried forward inside the writing statement; `changedFields: ["rules"]` (`repository-catalog.ts:438-449`) | Response; profile before/after | `repository-catalog.test.ts:412`; db `:312`; `repositories.test.ts:364` | low |
| P05 | Explicit null clears | profile has `scriptGroups` | save `scriptGroups: null` | Cleared; `changedFields` names it (`repository-catalog.ts:247-253`) | Response; profile | db `repository-catalog.test.ts:349`, `:800`; `repositories.test.ts:439` | low |
| P06 | A no-op save mints nothing | profile already says exactly what you send | save the same values | `unchanged: true`, no version minted, `changedFields: []`; UI says "Nothing was saved: the stored profile already matches this. No version was minted." | Response; `versionsCount` unchanged | `repository-catalog.test.ts:433`; `repository-entry.test.tsx:256`; `repositories.test.ts:407` | low |
| P07 | `changedFields` is empty on a create that sets none of the tracked fields | create with only `provider`+`path` | `PUT .../0` | `changedFields: []` and `unchanged: false`, the caller must read `unchanged`, not the array (`repository-catalog.ts:335-337`; `tool-catalog.ts:612`) | Response | `apps/worker/src/services/repository-catalog/authoring.matrix.test.ts:45` | med |
| P08 | Stale `expectedProfileVersion` | screen loaded at v3, another editor saved v4 | save with `expectedProfileVersion: 3` | 409 `repository_profile_conflict` with `currentVersion: 4`; nothing written; the refusal is carried by the writing statement, so it cannot be raced (`repository-catalog.ts:538-544`, `:590-593`) | 409 body; version history | `repository-catalog.test.ts:449`; db `:662`, `:819`; `authoring.test.ts:62`; `repositories.test.ts:558` | low |
| P09 | Two editors, second reloads | as P08 | after the 409, click Reload, re-apply, save | UI keeps the draft and shows "This repository moved to v{n} while you were editing. Reload to see the change before saving."; `baseVersion` does not advance until a reload | Screenshot of both tabs | `repository-entry.test.tsx:231` | med |
| P10 | No token at all | client written before the field | save with no `expectedProfileVersion` | The save proceeds unconditionally and silently overwrites (`repository-catalog-api.ts:155`) | Response; lost edit | `apps/worker/src/services/repository-catalog/authoring.matrix.test.ts:86` | med |
| P11 | `repositoryId: 0` for a path the catalog already holds, HTTP | row exists at `github:acme/web` | `PUT .../0` with that provider+path | The route **reconciles it into an edit** of the existing row (doc `repository-scripts.md:710-714`) | Response; whether a second row appeared | `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:202` | med |
| P12 | `repositoryId: 0` for an existing path, MCP | as P11 | `repositories.upsert {repositoryId: 0, ...}` | Refused `CONFLICT` naming the id to send instead (`tools/repositories.ts:366-382`) | Tool error | `repositories.test.ts:524` | low |
| P13 | Route id names a different repository | id 7 is `acme/api`, body says `acme/web` | `PUT .../7` | 409 `repository_mismatch` (`authoring.ts:128-136`) | 409 body | `repository-catalog.test.ts:239`; MCP `repositories.test.ts` via `tools/repositories.ts:413` | low |
| P14 | Unknown route id | id 99999 | `GET/PUT .../99999` | 404 "Unknown repository" (`authoring.ts:58-62`) | 404 body | `repository-catalog.test.ts:286` | low |
| P15 | Non-numeric route id | `/repository-catalog/abc` | GET | 404 "Unknown repository", deliberately not 400 (`route-id.ts:10-17`) | 404 body | `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:225` | low |
| P16 | Path that is not `owner/name` | any | `PUT` with `path: "acme"` | 400, regex `^[^/\s]+(?:\/[^/\s]+)+$` (`packages/contracts/repository-catalog.ts:59-67`) | 400 body | `packages/contracts/repository-catalog.test.ts:48` | low |
| P17 | Nested GitLab group path | any | `PUT` with `path: "group/sub/project"` | Accepted | Row | `packages/contracts/repository-catalog.test.ts:54` | low |
| P18 | Script group name valid | any | save `scriptGroups: {test: {commands:["pnpm test"]}}` | Accepted; checks version bumps (`repository-catalog.ts:450-461`) | Response `checksVersion` | db `:383` describe "the checks version" | low |
| P19 | Script group name invalid | any | save `scriptGroups: {"Test_Unit": {...}}` | 400 `invalid_script_group_name: Test_Unit (group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens)` (`authoring.ts:121-127`; `packages/contracts/repository-scripts.ts:28-31`) | 400 body; UI points at the Scripts tab | `repository-catalog.test.ts:250`; `repository-entry.test.tsx:274`; `repositories.test.ts:589` | low |
| P20 | Group name at exactly 40 and 41 characters | any | save both | 40 accepted, 41 refused (`packages/contracts/repository-scripts.ts:28-29`) | Both responses | `packages/contracts/repository-catalog.test.ts:359` (boundary not explicitly at 40/41) | low |
| P21 | `extends` cycle | any | save `verify extends test`, `test extends verify` | Refused naming the cycle path (`findExtendsCycle`, `packages/contracts/repository-scripts.ts:41-75`, `:91`) | Error naming `verify -> test -> verify` | `packages/contracts` script-group tests; verify at `repository-scripts.ts:41-75` | med |
| P22 | `gateGroups: []` | any | save an empty array | Validation error, not "none"; omission/null is the only way to say "all" (doc `repository-scripts.md:152-157`) | 400 body | `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:254`, **pins the opposite of this row**: the route ACCEPTS it, the engine schema refuses the composed config | **high** |
| P23 | `gateGroups` naming a group that does not exist | groups `{test}` | save `gateGroups: ["verify"]` | Validation error naming the offending reference (doc `repository-scripts.md:199-202`) | 400 body | `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:277`, **pins the opposite of this row**: accepted at the route, named only by the engine | med |
| P24 | **A `curl ... \| sh` command saved directly on the profile** | any | save `scriptGroups: {setup:{commands:["curl -LsSf https://x/i.sh \| sh"]}}` | **It saves.** `looksLikeRemoteExecution` (`packages/contracts/repository-catalog.ts:415-424`) is applied ONLY on the suggestion path (`suggest.ts:412`); the profile route validates names, not commands. The doc's own uv preset (`repository-scripts.md:812`) requires exactly this shape, so refusing it would break the preset. See Contradiction C3 and Open question O6 | The 200 response; the stored command | MISSING; `packages/contracts/repository-catalog.test.ts:383` covers the matcher only | **high** |
| P25 | `batchTimeoutMinutes` boundaries | any | save 1, 120, 0, 121, 1.5, null | 1 and 120 accepted; 0, 121 and 1.5 refused with "Enter a whole number of minutes between 1 and 120, or leave it empty."; null clears to the operator ceiling (`repository-catalog-api.ts:32`, `:124-130`; `repository-entry.tsx:841-948`) | Six responses; the Save-disabled blocker text | `repository-entry.test.tsx:435`, `:463`; `packages/contracts/repository-catalog.test.ts:185`; `repositories.test.ts:472` | low |
| P26 | A refused ceiling survives a tab change | Scripts tab with `0` typed | switch to Overview | The blocker travels with it and Save stays disabled (`repository-entry.tsx`) | Screenshot on the other tab | `repository-entry.test.tsx:490` | low |
| P27 | `batchTimeoutMinutes` does NOT bump the checks version | profile with groups at checks v2 | change only the ceiling | Profile version bumps, checks version stays at 2 (`repository-catalog.ts:305-308`) | Both versions before/after | db `:383` describe; verify explicitly | low |
| P28 | Prose-only change does not bump the checks version | profile with groups | change only `description` | Profile version +1, checks version unchanged, so no run in flight fails at Finalize (doc `repository-scripts.md:243-246`) | Versions; a run in flight completes | `repository-catalog.test.ts:213`; `workspace-gate.test.ts:1014`, `:1033` | med |
| P29 | Relationships: self-reference and duplicates | repository id 5 | save `relationships: [{repositoryId:5,label:"self"},{repositoryId:6,label:"a"},{repositoryId:6,label:"b"}]` | **All accepted**, no self-reference check, no dedupe, no array length cap (`packages/contracts/repository-catalog.ts:49-54`). See Open question O7 | The stored array; how the Overview tab renders it | MISSING | med |
| P30 | Relationships pointing at a deleted/unknown repository id | `relationships:[{repositoryId: 99999,...}]` | save | Accepted (positive int only); the Overview tab must not crash | Screenshot of Overview | MISSING | med |
| P31 | `reason` empty on the HTTP save | any | `PUT` with no `reason` | Accepted, `reason` has `.default("")` (`repository-catalog-api.ts:140`), so an unattributed version row is minted. MCP requires a non-empty reason (`tool-catalog.ts:612`). See Contradiction C4 | The version row's `reason`; the History tab rendering | MISSING | med |
| P32 | Description and rules at 20 000 and 20 001 characters | any | save both | 20 000 accepted, 20 001 refused (`packages/contracts/repository-catalog.ts:57`) | Both responses | MISSING (boundary) | low |
| P33 | History paging through MCP | 120 versions | `repositories.list_versions {limit:50}` then `{before: <oldest version>}` | Pages of 50, `hasMore` true then false; `changedFields` is null for the version whose predecessor is on the next page; `versionsCount` comes from a count query, not the page length (`version-history.ts:41-66`) | Three pages; `versionsCount` | `repositories.test.ts:284`, `:330`, `:222` | low |
| P34 | **History through HTTP is unpaged** | 5 000 versions on one repository | `GET /api/v1/repository-catalog/:id/versions` | The whole history comes back in one body (`versions.get.ts:10-19`), a latency and payload cliff the MCP surface does not have. See Contradiction C5 | Response size and time | `repository-catalog.test.ts:298` (small fixture only) | med |
| P35 | Restore an old version from History | 4 versions | UI: History, Restore v2 | Saves v2's fields FORWARD as v5, rewinds nothing, and the reason says what it was (`tool-catalog.ts:600`) | New version row and its reason | `repository-entry.test.tsx:313` | low |

## 3. Suggestions

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| S01 | Happy path suggestion | repository with README, manifests, CI | UI: entry, Suggest from repository. MCP: `repositories.suggest {repositoryId, idempotencyKey}` | Proposal with `source:"suggested"`, per-group `provenance`, shown BESIDE current values; nothing written (`suggest.ts:6-10`, `:287-299`) | Proposal JSON; screenshot showing current vs proposed | `repository-catalog-import-suggest.test.ts:230`; `suggest.test.ts:124`; `suggestion-panel.test.tsx:129` | low |
| S02 | Accept one group only | after S01 | tick one group's "Use this" | It lands in the Scripts draft; nothing is saved; a separate Save with a reason is still required (`suggestion-panel.tsx`) | Draft state; no version minted | `suggestion-panel.test.tsx:156` | low |
| S03 | Accept a description or rules field | after S01 | click "Use this" on Description | Per-field acceptance only, there is no "accept all" | Screenshot | `suggestion-panel.test.tsx:298` | low |
| S04 | Reject everything / navigate away | after S01 | close the panel | Nothing written, no version minted; the suggestion row is still recorded and billed | `repository_suggestions` row exists, profile version unchanged | `suggest.test.ts:367` (malformed variant) | low |
| S05 | Dropped group: invalid name | model proposes `Test_Unit` | S01 | Comes back in `droppedGroups` with reason `invalid_name` and its commands, greyed out, never acceptable (`suggest.ts:404-410`) | Screenshot of the greyed group | `suggestion-panel.test.tsx:182`; `packages/contracts/repository-catalog.test.ts:344` | low |
| S06 | Dropped group: remote execution | model proposes `curl ... \| sh` | S01 | Dropped with reason `remote_execution`; the WHOLE group is dropped, not just the command (`suggest.ts:412-418`) | Dropped list | `packages/contracts/repository-catalog.test.ts:383`; `suggestion-panel.test.tsx:182` | low |
| S07 | Repository with no README and no manifests | empty repository | S01 | Still produces a proposal from provider metadata alone (doc `repository-scripts.md:405-407`) | Proposal; bundle truncation notes | `apps/worker/src/services/repository-catalog/suggest.matrix.test.ts:110`, `:143` | low |
| S08 | Bundle truncation is stated in the prompt | repository with a 500 KB README | S01 | The cut is recorded in the bundle and said in the prompt, so the model writes a shorter description | Captured prompt | `suggest.test.ts:154`, `:164` | low |
| S09 | Provider 429 or 5xx | stub the model provider | S01 | 503 `suggestion_provider_unavailable` (retryable); row recorded `failed`; UI auto-retries ONCE with "The model provider is not answering right now. Nothing was changed. Try again in a minute." (`suggest.ts:356-361`) | Response; suggestion row; screenshot | `suggest.test.ts:329`; `suggestion-panel.test.tsx:228`, `:239`; MCP `repositories.test.ts:1117` | low |
| S10 | Provider 401/403 | rotate the model key away | S01 | 502 `suggestion_failed` (NOT retryable) (`suggest.ts:362`) | Response | `suggest.test.ts:351` | low |
| S11 | Repository 404 at the provider | delete or lose access to the repository | S01 | 404 `repository_missing_at_provider`, outcome `missing`, no model call, no spend, and it cannot tell a deleted repository from a revoked token (doc `repository-scripts.md:520-526`) | Response; row outcome; the token checked separately | `suggest.test.ts:296`; `repository-catalog-import-suggest.test.ts:327`; `repositories.test.ts:1141` | med |
| S12 | Profile read timeout (60 s) | stall the provider | S01 | 503 `profile_source_timed_out`, outcome `timeout`, tokens null → shown as `unpriced` (`suggest.ts:341-349`) | Response; History row reading `unpriced` | `suggest.test.ts:281`; `repository-catalog.test.ts:492` | low |
| S13 | Model timeout (90 s) | stall the model | S01 | 503 `suggestion_timed_out`; the UI does NOT auto-retry and says "The model did not answer within 90 seconds... The call still counts against the cost page as unpriced. Try again." | Screenshot; row | `suggest.test.ts:268`; `suggestion-panel.test.tsx:212` | low |
| S14 | Malformed model answer | stub a schema-violating answer | S01 | 502 `suggestion_malformed`, exactly one row, no profile version, and the provider's own words never reach the body (`suggest.ts:250-259`) | Response; row count | `suggest.test.ts:367`, `:236`; `repository-catalog-import-suggest.test.ts:292`, `:310` | low |
| S15 | Rate limit, 11th call in an hour | 10 suggestions recorded | S01 | 429 `suggestion_rate_limited` with `retryAfterSeconds` and a `Retry-After` header; NOTHING recorded; the countdown is computed from the oldest row in the window (`suggest.ts:93-97`, `:309-319`) | 429 body and header; row count unchanged; UI countdown | `repository-catalog-import-suggest.test.ts:343`; `repositories.test.ts:1088`; `suggestion-panel.test.tsx:273` | low |
| S16 | Two clicks in one browser | click Suggest twice quickly | UI | One provider call, one recorded row (process-local in-flight map, `suggest.ts:143`, `:176-186`) | Row count = 1 | `suggest.test.ts:190`, `:210`, `:220` | low |
| S17 | Two MCP calls with the same idempotency key while one is in flight | as S16 but through MCP | `repositories.suggest` twice, same key | The second is refused `CONFLICT` "Mutation is still in progress; retry", the agent gets an error where a browser gets the answer. See Open question O8 | Both tool responses | `execute-tool.ts:355-512` machinery; MISSING for this specific UX divergence | med |
| S18 | History paging, bad cursor | 120 suggestion rows | `GET .../:id/suggestions?cursor=garbage` | 400 `invalid_cursor` (`authoring.ts:232-234`); a valid cursor pages 50 at a time, newest first (`repository-catalog-api.ts:385`) | Both responses | `repository-catalog.test.ts:539`, `:492` | low |

## 4. Runs and the catalog

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| R01 | PR webhook on a disabled repository | activated catalog, `acme/web` disabled | push a PR event | Dispatch declined; delivery recorded `ignored_repository_not_enabled`, log `trigger_repo_not_enabled_in_catalog` (`dispatch-trigger.ts:280-284`) | Delivery record; worker log | `dispatch-trigger.test.ts:531`, `:594`, `:618`; `services/dispatch/repo-allowlist.test.ts:55`, `:108`; `github.post.test.ts`, `gitlab.post.test.ts` | low |
| R02 | Manual dispatch of a PR on a disabled repository | as R01 | UI: dispatch a PR | Refused with "This repository is not enabled in the repository catalog." (`services/dispatch/repo-allowlist.ts:38-40`) | Screenshot; response | `services/manual-dispatch/resolve.test.ts:361`; `dispatch-trigger.test.ts:594` | low |
| R03 | A pending event queued while busy, repository disabled meanwhile | event queued, then disable the repository | let the drain tick run | Asked again on the tick that drains it and dropped, not dispatched late (doc `repository-scripts.md:296-299`; `poll-pass.ts:186-194`) | Delivery record | `apps/worker/src/services/dispatch/dispatch-trigger.test.ts:499`, **the row was wrong, this test already existed** | med |
| R04 | **Ticket-driven dispatch (Jira column) with a disabled repository** | activated catalog, ticket names a disabled repository | move the ticket into the trigger column | The catalog decides dispatch on exactly FOUR paths (doc `repository-scripts.md:285-291`): both webhooks, the legacy post-PR gate, manual PR dispatch and MCP dispatch. A ticket trigger is NOT one of them, so the run STARTS and is refused inside, after it has spent an agent invocation. See Open question O1 | The run record; where in the timeline it failed; the cost spent | MISSING | **high** |
| R05 | **Catalog read fails on a poll tick** | make the catalog query error | watch one cron tick | `repositoryCatalogOrNull` returns null, `poll_repository_catalog_skipped` is logged and the dispatch phases return early (`poll-pass.ts:82-109`, `:445-448`): dispatch silently stops for that tick with only a warn line | The log; a run that did not start | MISSING | **high** |
| R06 | Ticket names an unknown repository | activated catalog | dispatch a ticket naming `acme/nope` | Clarification: "Research requested unavailable repository {provider}:{repoPath}. Which accessible repository should be used?" (`repository-discovery/runner.ts:182-186`) | Clarification text on the run | `apps/worker/src/services/repository-discovery/runner.matrix.test.ts:61` (catalog miss), `:80` (present but not usable) | med |
| R07 | Ticket names two enabled repositories | both enabled | dispatch | Both checked independently and both enter the workspace (`runner.ts:163-186`) | Run workspace listing | `multi-repo-research.test.ts` (engine) | low |
| R08 | More than 3 repositories in one expansion round | ticket names 4 | dispatch | Refused at `runner.ts:150-153` | Clarification / failure text | `apps/worker/src/services/repository-discovery/runner.test.ts:301`; exact text and the requests-not-fresh counting at `apps/worker/src/services/repository-discovery/runner.matrix.test.ts:100`, `:118` | med |
| R09 | More than 8 repositories in the workspace | expand past `MAX_WORKSPACE_REPOSITORIES = 8` | dispatch | Refused at `runner.ts:196-198` | Failure text | `apps/worker/src/services/repository-discovery/runner.matrix.test.ts:143` (the text, model-round path), `:169` (8 allowed, 9 not) | med |
| R10 | Third expansion round (the T32 loop) | one repository already attached, planner keeps asking | dispatch a research ticket | `EXPANSION_LIMIT_CLARIFICATION_PREFIX` after 2 rounds (`runner.ts:121-144`). Known production behaviour: the loop asks in circles when the only repository is already attached | The clarification text; how many times it repeated | `apps/worker/src/services/repository-discovery/runner.matrix.test.ts:194` (the whole clarification), `:215` (the ask-in-circles loop) | **high** |
| R11 | Frozen list on the run row | activated catalog, 3 enabled | start a run | `workflow_runs.repository_access` carries `{activated, enabledKeys}` frozen at run start by `loadRunStartSettingsStep` (`run-start-settings.ts:66-100`; `db/schema/runs.ts:114`); log `run_start_settings` | The DB column; the log line | `run-carried-settings.test.ts:113` | low |
| R12 | Run header states the frozen list | as R11 | UI: open the run | "Repository access frozen at start: 3 enabled (a, b, c)." and, past 5 keys, "and N more" (`apps/dashboard/lib/run-repository-access.ts:21-40`) | Screenshot | `apps/dashboard/lib/run-repository-access.test.ts` | low |
| R13 | Run header on a bridge run | run started while `activated=false` | UI: open the run | "Repository access frozen at start: bridge, nobody had activated the catalog, so every repository the installation exposes was reachable." | Screenshot | `run-repository-access.test.ts` | low |
| R14 | Run header on a run predating the column | a run older than migration 0062 | UI: open the run | The line renders NOTHING (null is not an empty list, `run-repository-access.ts:24`) | Screenshot showing no line | `run-repository-access.test.ts` | low |
| R15 | **A suspended run that predates the column, resumed after activation** | a run suspended before stage X, catalog now activated | let it resume | `runStartRepositoryAccess` treats a missing record as `{activated:false, enabledKeys:[]}`, the BRIDGE, so the resumed run is unrestricted on an activated deployment (`run-start-settings.ts:128-137`). Deliberate, but it means the production drain (plan assumption 14) is the only thing that closes it | The run's access line vs the catalog; which repositories it touched | `apps/worker/src/engine/run-carried-settings.matrix.test.ts:116`, `:153` | **high** |
| R16 | `runs.get` / `runs.diagnose` carry the same field | any run | MCP: `runs.get` | `repositoryAccess` verbatim; `activated:false` is the bridge, `null` is "before the list was recorded" (doc `repository-scripts.md:590-596`) | Both tool responses | `apps/worker/src/mcp/tools/runs.test.ts` (field present) | low |
| R17 | Disable a repository mid-run | run in flight touching `acme/web` | disable it at minute 3 | The run keeps contributing that repository's rules and access; the NEXT run does not (`repository-access.ts:6-21`) | Run completes; next run refused | `run-carried-settings.test.ts:113`, `:145` | low |
| R18 | Direct action on a repository outside the frozen list | run in flight; the agent tries to open a PR on a repository the list never carried | force it | Fails with "Refusing to {action} {provider}:{repoPath}: this repository was not enabled in the repository catalog when this run started. Enable it on the Repositories page and re-dispatch the ticket." (`repository-access.ts:88-90`) | The failure text on the run | `repository-prs.test.ts`; `repository-promotion.test.ts`; `run-carried-settings.test.ts:145` | low |
| R19 | Rules reach the compiled prompt | profile with `rules`, harness `includeRepositoryInstructions: true` | run and read the compiled prompt | Section headed `Repository rules for <owner/name>` with the delimiters, ordered AFTER the repository's committed `AGENTS.md`/`CLAUDE.md` and ahead of `.ai/memory` (`packages/prompts/effective-prompt.ts:268-270`) | The compiled prompt | `apps/worker/src/engine/steps/repository-rules.test.ts:150`, `:400`; golden fixture at `apps/worker/src/engine/steps/repository-rules.matrix.test.ts:138` against `apps/worker/src/engine/steps/__golden__/repository-rules-prompt.golden.txt` | low |
| R20 | The seven identity variables render, and nothing else does | rules using all seven plus `{{ticket_description}}` | run | `ticket_key, ticket_url, branch_name, run_id, pr_number, pr_url, repo_path` render; `{{ticket_description}}` is left standing braces and all, and is logged ONCE per compiled prompt as `repository_rules_unresolved_variable` (`prompt-variables.ts:46-54`; `repository-instructions.ts:277-297`) | The prompt; the log line and its count | `apps/worker/src/engine/steps/repository-rules.test.ts:205`, `:179`, `:249`; the whole set rendered in one artefact at `apps/worker/src/engine/steps/repository-rules.matrix.test.ts:153` | low |
| R21 | `repo_path` differs per repository | one rules text, two repositories | run touching both | Each compilation resolves `repo_path` to its own repository | Both sections in the prompt | `repository-rules.test.ts:231` | low |
| R22 | Rules are best effort | make the catalog read fail mid-run | run | The rules are lost, the run is not (`repository-instructions.ts`; doc `repository-scripts.md:602-604`); a field over 32 KiB is trimmed and says so (`repository_rules_truncated`) | The run completes; the warn lines | `repository-rules.test.ts:321`, `:328`, `:352` | low |
| R23 | **Checks ceiling across two repositories** | repo A ceiling 5, repo B ceiling 30, one run touching both | run the checks phase | The run takes the LARGEST claim, 30, not the smallest and not the sum (`db/repositories/repository-catalog.ts:975`, `:1046-1052`); the sandbox is sized `JOB_TIMEOUT_MS + ceiling` at workspace creation and editing it mid-run does nothing in EITHER direction (doc `repository-scripts.md:174-183`) | The batch budget in the run log; the sandbox lifetime | `apps/worker/src/db/repositories/repository-catalog.test.ts:543` (the largest claim); `apps/worker/src/engine/blocks/agent-sandbox.matrix.test.ts:163` (the lifetime), `:185` (a mid-run edit moves nothing), `:225` (the fallback) | med |

## 5. Settings interplay

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| T01 | `repositories` group refused on the HTTP patch | any | `PATCH /api/v1/settings {"catalog.activated": true}` | 400 "Not editable here: catalog.activated. Activate the repository catalog from the Repositories page, which posts to /api/v1/repository-catalog/activate." (`settings.patch.ts:38-44`; `api-editability.ts:27,49-52`) | 400 body | `apps/worker/src/routes/api/v1/settings.test.ts:176` (the 400); `apps/worker/src/routes/api/v1/repository-catalog.matrix.test.ts:299` (the catalog state row is untouched) | low |
| T02 | `catalog.activated` never answers for activation | an admin activated the catalog | UI: Settings page | Both the setup overview and the Repositories summary read `catalogState` from the catalog list route, NOT the registry key, and say who activated it and when (`apps/dashboard/AGENTS.md` Settings section) | Screenshot showing "Activated" | `apps/dashboard/lib/settings/*.test.ts` | med |
| T03 | `repositories` group renders as a card, not a form | any | UI: Settings | One-line summary card, not an editable form | Screenshot | dashboard settings tests | low |
| T04 | `MCP_ENABLED` writable over HTTP, refused over MCP | any | `PATCH /api/v1/settings {"MCP_ENABLED": false}` then `settings.set` with the same key | HTTP writes it; MCP refuses it with VALIDATION_FAILED pointing at the dashboard (`api-editability.ts:31,43,74-81`) | Both responses | `settings.test.ts:373` | low |
| T05 | `mcp` group refused over MCP only | any | `settings.set` on an `mcp` key | Refused; the HTTP patch still writes it | Both responses | `settings.test.ts:373` | low |
| T06 | `requiresRedeploy` key | `PRE_PR_CHECKS_ALLOWED_ENV` | `settings.set` it, then run a check using the new name | Stored, `appliesToRunsInFlight: "after redeploy"`, and the check still fails until a redeploy because the runner reads `process.env` (`settings-registry.ts:373-389`) | The reply; the failing check before the redeploy; the passing one after | `settings.test.ts:149` | med |
| T07 | `settings.reset` hands an ordinary key to its registry default | a stored ordinary setting | `settings.reset` | `removed: true`; `value` and `source` report the registry default, with no environment fallback | The reply | `settings.test.ts:471` | low |
| T08 | Reset a key that was never stored | any | `settings.reset` | `removed: false` with the value that was already resolving; a success, not an error | The reply | `settings.test.ts:507` | low |
| T09 | No credential appears in the settings surface | any | `settings.list` | No key that looks like a credential; secrets stay in the environment | The full list | `settings.test.ts:169` | low |
| T10 | Retired-variable status surface is gone | no retired variable is set | inspect `/health`, MCP `settings.list`, and Settings | None carries `migratedVariablesSet` or `migratedVariablesUnstored`; a retired name is refused by build and boot instead | Response bodies and the refusal test | `health-response.test.ts`, `settings.test.ts`, dashboard settings tests, `retired-environment.test.ts` | low |

## 6. MCP parity and auth

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| M01 | Read tools on an `mcp:read` client | client-credentials token with `mcp:read` | `repositories.list`, `repositories.get`, `repositories.list_versions`, `settings.list`, `settings.get` | All five answer (`tool-catalog.ts:584,590,600,713,719`) | Five responses | `repositories.test.ts:164`, `:186`, `:222`; `settings.test.ts:114`, `:181` | low |
| M02 | Write tool without `repositories:write` | token holding only `workflows:write` | `repositories.upsert` | `INSUFFICIENT_SCOPE` / "Insufficient scope" naming the scope (`apps/worker/src/mcp/policy.ts:456-462`) | Tool error | `repositories.test.ts:1223`; `settings.test.ts:608` | low |
| M03 | Right scope, wrong role | member token holding `repositories:write` | `repositories.upsert` | `FORBIDDEN` / "Access denied" (`policy.ts:456-462`) | Tool error | `repositories.test.ts:615`, `:718`, `:1055`, `:1155` | low |
| M04 | Client-credentials token on a mutation | machine token | `repositories.upsert`, `set_enabled`, `import`, `suggest` | All refused: `withoutAuthoringScopes` strips both configuration scopes from a token with no `sub` (doc `repository-scripts.md:684-691`) | Four tool errors | `repositories.test.ts:615`, `:718`, `:1055`, `:1155` | low |
| M05 | `repositories.activate` is owner only and person-backed | admin person token; then owner client-credentials token | `repositories.activate` | Both refused; only an owner with a person behind the token succeeds | Two tool errors plus the success | `repositories.test.ts:882` | low |
| M06 | `settings.reset` is owner only | admin token | `settings.reset` | Refused, stricter than the HTTP route, which admits an admin (`dashboard-roles.ts:73-81` vs `tool-catalog.ts:744`) | Tool error; the HTTP route succeeding for the same actor | `settings.test.ts:512`, `:598` | low |
| M07 | Activation digest binds to what was read | run `activate_preview`, then enable a repository, then activate with the old digest | MCP | VALIDATION_FAILED naming the current populations; nothing activated; the key is free to reuse (`tools/repositories.ts:569`) | Both responses | `repositories.test.ts:848` | low |
| M08 | A repository takes a run claim between preview and activate | as M07 but start a run on a disabled repository in between | MCP | `CONFLICT` naming it, nothing activated | Tool error | `repositories.test.ts:914` | low |
| M09 | Idempotency replay | any mutation | call twice with the same `idempotencyKey` | The second replays the stored response; no second version, no second row (`execute-tool.ts:355-512`, lease 15 min, terminal answer kept 24 h) | Both responses identical; one version row | `settings.test.ts:396` | low |
| M10 | `effectNotApplied` on a refused write | force a provider failure inside `repositories.import` | MCP | `DEPENDENCY_UNAVAILABLE` with `effectNotApplied`, and the idempotency key is RELEASED for reuse rather than pinned to the failure (`services/mcp/contracts.ts:87-93`; `execute-tool.ts:411`; `tools/repositories.ts:153-163`) | The error; a retry with the same key succeeding | `repositories.test.ts:1034`, `:1117` | med |
| M11 | `repositories.suggest` timeout ceiling | stall the model 200 s | MCP | The tool raises its own floor to ~150 s and is clamped to `MCP_MAX_TOOL_TIMEOUT_MS` 240 s (`execute-tool.ts:62`); the client sees `TIMEOUT`, deliberately not `DEPENDENCY_UNAVAILABLE` | The error code and elapsed time | `repositories.test.ts:1283` | low |
| M12 | Scope rollout on an old client | a client registered before `repositories:write` existed | re-authorize, then call `repositories.upsert` | Still refused: a client carries the ceiling it registered with, and the consent screen can only offer what the registration allows (doc `repository-scripts.md:692-698`). Register a new client or edit the stored row | The consent screen; the refusal | `apps/worker/src/mcp/tools/repositories.matrix.test.ts:268` (refused), `:338` (the same call with the scope stored) | **high** |
| M13 | **`repositories.list` has no script group count** | rows with groups | compare `repositories.list` with `GET /api/v1/repository-catalog` | HTTP carries `scriptGroupCount` (`store.ts:41-45`; `packages/contracts/repository-catalog.ts:90-100`); the MCP tool deliberately does not and reports `checksVersion` instead (`tool-catalog.ts:584`). The parity rule says every dashboard action has a tool; this is a data gap, not an action gap. See Contradiction C6 | Both responses side by side | `repositories.test.ts:164`; `repository-catalog.test.ts` | med |
| M14 | **`repositories.import_preview` has no test** | any | MCP | Works, presumably; there is no `describe("repositories.import_preview")` block in `repositories.test.ts` (the file covers list, get, list_versions, upsert, set_enabled, activate_preview, activate, import, suggest) | Tool response | `apps/worker/src/mcp/tools/repositories.matrix.test.ts:135` (the listing), `:182` (**correction**: the tool is admin/owner + `repositories:write`, unlike the HTTP route) | med |
| M15 | Activation protocol differs between surfaces | any | HTTP `activate` needs `acknowledgedRepositoryKeys`; MCP `activate` needs `previewDigest` | Two different concurrency mechanisms for the same action; an operator scripting against HTTP cannot reuse the MCP digest and vice versa. See Open question O4 | Both request shapes | `repository-catalog.test.ts:365`; `repositories.test.ts:848` | med |
| M16 | Audit trail records the target, never the reason text | any mutation | `repositories.upsert`, `settings.set` | The audit row names the repository / key touched and does NOT store the reason as free text on the audit line | The audit rows | `repositories.test.ts:1185`; `settings.test.ts:645` | low |
| M17 | MCP upsert advertises a looser path than it enforces | any | `repositories.upsert` with `path: "acme"` | The tool's own `inputSchema` accepts it (`tool-catalog.ts:612`, plain string), then the handler re-parses through `repositoryCatalogUpsertRequestSchema` and refuses with VALIDATION_FAILED (`tools/repositories.ts:425-468`). The advertised contract and the enforced one differ | The tool error and the advertised schema | `apps/worker/src/mcp/tools/repositories.matrix.test.ts:231` | low |

## 7. UI states

| id | scenario | preconditions | steps | expected | evidence to capture | automated test | risk |
|---|---|---|---|---|---|---|---|
| U01 | Empty list | zero rows | `/repositories` | "The catalog is empty. Import the repositories this installation exposes, then enable the ones the agent may touch." + Import (`repositories-screen.tsx:234-249`) | Screenshot | `repositories-screen.test.tsx:97` | low |
| U02 | Empty list as a viewer | zero rows, member | `/repositories` | Same copy, no Import button to press | Screenshot | `repositories-screen.test.tsx:111` | low |
| U03 | Loading | slow worker | `/repositories` | "Loading repositories..." (`page.tsx:9-13`) | Screenshot | `apps/dashboard/app/(cockpit)/repositories/repositories-screen.matrix.test.tsx:167` | low |
| U04 | Worker did not answer | stop the worker | `/repositories` | "The worker did not answer, so nothing can be shown or changed here. Check the worker on the System health page and reload." (manager) / the read-only variant (`repositories-screen.tsx:177-183`) | Screenshot both roles | `repositories-screen.test.tsx:214` | low |
| U05 | Optimistic switch superseded by a server refresh | flip a switch, then a server refresh arrives | `/repositories` | The refreshed row wins over the optimistic one | Screenshot sequence | `repositories-screen.test.tsx:246`, `:223` | low |
| U06 | A repository nobody configured | `profileVersion = 0` | `/repositories` | "never configured" rather than "v0"; "no script groups" rather than "0 groups" when `checksVersion === 0` (`repositories-screen.tsx:36-41`, `:288-294`) | Screenshot | `repositories-screen.test.tsx:204`, `:263` | low |
| U07 | An absent script group count is not zero | list response without `scriptGroupCount` | `/repositories` | The count line is omitted entirely, never rendered as "0 script groups" (`format.ts:130`) | Screenshot | `format.test.ts:148`; `repositories-screen.test.tsx:263` | low |
| U08 | **Tab deep link** | entry with 5 tabs | open `/repositories/7`, click Scripts, copy the URL, reload | **The tab is local `useState` (`repository-entry.tsx:146`), not a route segment or a query param**, so the URL never changes and a reload always lands on Overview. Sharing "the Scripts tab of repo 7" is impossible. See Open question O9 | The URL bar before and after; the tab after reload | MISSING | med |
| U09 | Unsaved-edit guard | dirty draft on the entry | navigate away in the cockpit shell | `hasUnsavedSettings()` is asked before every `router.push` and the entry registers its draft in the shared registry; `beforeunload` covers the browser close (`apps/dashboard/AGENTS.md` Settings section) | The prompt | dashboard settings/unsaved tests | low |
| U10 | Markdown table in Rules | rules containing a table | entry, Rules tab | The visual editor cannot represent it, so the field opens forced-raw with "This text uses markdown the visual editor cannot represent; edit it as raw markdown to keep it intact." | Screenshot; the markdown unchanged after a save | prompt-editor `markdown-round-trip` tests; `repository-entry.test.tsx:297` | low |
| U11 | `{{repo_path}}` survives a visual edit | rules containing `{{repo_path}}` | type a word next to it in the visual editor, save | Still `{{repo_path}}` and not `{{repo\_path}}`, `restoreVariableTokens` undoes the underscore escaping | The stored markdown | prompt-editor `markdown-round-trip` tests | med |
| U12 | Variable palette shows exactly seven | entry, Rules tab | open the palette | `ticket_key, ticket_url, branch_name, run_id, pr_number, pr_url, repo_path` and nothing else, so the menu, the highlight and the renderer agree (doc `repository-scripts.md:619-621`) | Screenshot of the palette | `apps/dashboard/app/(cockpit)/repositories/repository-entry.matrix.test.tsx:174` | med |
| U13 | Unknown variable in Rules | type `{{ticket_description}}` | entry, Rules tab | Rendered with the `ck-var-unknown` decoration (yellow) in the editor and left literal at run time | Screenshot; the compiled prompt | `repository-rules.test.ts:249` (runtime half only) | low |
| U14 | Deploy pin warning, keyboard | activated catalog, a definition pinning a disabled repository | workflow editor, Deploy | `deploy-pin-warning.tsx` is a static `role="status"` with **no keyboard affordance**; the real dialog is `repository-scope-modal.tsx` with `role="dialog" aria-modal="true"`, a focus trap and Escape. Tab order must reach the modal, not the status line | Keyboard-only walkthrough; screenshots | `apps/dashboard/components/cockpit/flow-editor/deploy-pin-warning.matrix.test.tsx:75`, `:91` (nothing to focus), `:105` (the control that is focusable), `:129` (the dialog's semantics) | med |
| U15 | Mobile width, 390 px | any | `/repositories` and `/repositories/7` at 390 px | Rows and tabs wrap (`flex-wrap`, `sm:`/`md:`); dialogs cap at `max-h-[calc(100dvh-32px)]`; no horizontal page scroll | Screenshots at 390 px | `apps/dashboard/app/(cockpit)/repositories/repositories-screen.matrix.test.tsx:183`, `:208`; `apps/dashboard/app/(cockpit)/repositories/repository-entry.matrix.test.tsx:215`, `:232` | low |

---

## Contradictions

**C1. The "enable at least one first" guard exists on two surfaces and not in the service that both are supposed to share.**
`docs/architecture/repository-scripts.md:737-743` says "Both derivations of that population have to move together... and the service's own acknowledgement check is what refuses an activation either of them got wrong." The service (`apps/worker/src/services/repository-catalog/authoring.ts:286-320`) checks acknowledgement only. The zero-enabled refusal is duplicated in `apps/dashboard/lib/repository-catalog/activation.ts:110-111` and `apps/worker/src/mcp/tools/repositories.ts:556`, with the same sentence in both. `POST /api/v1/repository-catalog/activate` has neither. Row L18.

**C2. `enabledRemaining` is promised by the switch and delivered only through MCP.**
`apps/worker/src/mcp/tool-catalog.ts:651` describes `enabledRemaining` as "the switch on each row of the Repositories list". The HTTP route `[id]/enabled.patch.ts:17-41` returns `RepositoryCatalogMutationResponse` with no such field, and nothing in `repositories-screen.tsx` warns when the count reaches zero. Row L25.

**C3. The remote-execution matcher guards the suggestion and not the save.**
`packages/contracts/repository-catalog.ts:415-424` is consumed only at `apps/worker/src/services/repository-catalog/suggest.ts:412`. `docs/architecture/repository-scripts.md:426-431` frames it as a property of what "reaches the admin", which is accurate; the brief's expectation that "the script safety matcher refuses `curl | sh`" on the authoring path is not what the code does, and the document's own uv preset at `:812` depends on it not doing so. Row P24.

**C4. `reason` is required on MCP and optional on HTTP.**
`repository-catalog-api.ts:140` gives `reason` `.default("")`; `tool-catalog.ts:612` requires `z.string().trim().min(1)`. `docs/architecture/repository-scripts.md:730-733` presents the reason as recorded on both surfaces alike. A profile version minted through the HTTP route with no reason shows an empty History line. Row P31.

**C5. History paging exists on MCP and not on HTTP.**
`docs/architecture/repository-scripts.md:744-746` ("Both histories are paged") is about the MCP surface; `apps/worker/src/routes/api/v1/repository-catalog/[id]/versions.get.ts:10-19` returns the whole history in one body. Row P34.

**C6. The list's script group count.**
`docs/architecture/repository-scripts.md:551-556` says the list row carries `scriptGroupCount`, and it does over HTTP (`store.ts:41-45`). `apps/worker/src/mcp/tool-catalog.ts:584` states the opposite for the MCP list, explicitly and deliberately. Both are true of their own surface; the parity claim at `:655-657` ("Every action... is also a tool... under the same rules") reads as stronger than what shipped. Row M13.

**C7. `apps/dashboard/AGENTS.md` contradicts itself about the profile save.**
Line 116 says the entry "sends ONLY the fields that changed plus `expectedProfileVersion`" and line 120 says that is "why the screen no longer reads the row before writing it". Line 154 says "**Saving a profile is a full overwrite, so the screen re-reads first.** The upsert takes no version token." The second paragraph is stage-G text that stage W replaced; the code matches lines 116-120 (`repository-entry.tsx:207-256`).

**C8. `apps/worker/AGENTS.md:181` says the catalog "is not deciding yet".**
The same bullet then says "The services tier decides dispatch from it now, on four paths" (`:191`) and "The same catalog decides access INSIDE a run" (`:200`). The heading is pre-D1 text.

**C9. The plan lists MCP tools for the catalog as out of scope, then adds them as stage M.**
`docs/plans/2026-09-11-repository-catalog-and-settings.md:71` ("Out of scope: MCP tools for the catalog and settings, a follow-up once the HTTP contract has been used by the dashboard for a while") versus stage M at `:106`, added 2026-09-12 on the owner's parity rule. The "used for a while" condition was dropped without being retired in the Out of scope list.

**C10 (limits, minor).** `docs/architecture/repository-scripts.md:160-161` gives `batchTimeoutMinutes` the range 1-180 (the legacy blob field) and `:631` gives the profile field 1-120. `packages/contracts/repository-catalog-api.ts:32` is 120 and says so deliberately. Reading the document top to bottom, the first number is wrong for anything an operator can now type.

## Open product questions

**O1. A ticket trigger does not consult the catalog at dispatch.** The catalog decides on four paths (`repository-scripts.md:285-291`), none of which is a Jira ticket entering a column. A ticket naming a disabled repository therefore starts a run, prepares a workspace and is refused inside. *Recommendation:* keep the in-run refusal (it is the only correct place for a repository chosen by expansion), but add the enabled-set check to the run-start step's own failure path so the run fails before the first agent invocation, and say so in the ticket comment.

**O2. Nothing reconciles a repository deleted at the provider.** The row stays, the switch stays on, dispatch keeps passing it, and only a suggestion surfaces the 404. *Recommendation:* mark the row stale on the first `repository_missing_at_provider` and show it on the list; do not auto-disable.

**O3. `skipped` conflates "gone" with "the token cannot see it".** `import.ts:154-156`. *Recommendation:* keep one bucket but change the copy to "not in this installation's listing (removed, or not visible to the configured token)".

**O4. Two activation protocols.** HTTP acknowledges keys, MCP binds a digest. *Recommendation:* accept `previewDigest` on the HTTP route as an alternative, and make the zero-enabled refusal a service-level check both share (closes C1 at the same time).

**O5. `enabled` on an upsert of an existing repository is silently ignored.** *Recommendation:* answer 400 naming `repositories.set_enabled` / the switch, rather than accepting and discarding.

**O6. Should the profile route refuse `curl | sh`?** The suggestion path does; the save path cannot without breaking the documented uv preset. *Recommendation:* leave the save permissive, but show the matcher's verdict as a non-blocking warning beside the command in the Scripts tab, so an operator pasting a proposal sees what the suggestion filter would have dropped.

**O7. Relationships accept self-references, duplicates and unbounded length.** *Recommendation:* refuse self-reference, dedupe by `repositoryId`, cap at 50.

**O8. A second `repositories.suggest` with the same key is a CONFLICT, where a second browser click is a join.** *Recommendation:* have the MCP handler await the in-flight promise the same way, or document the retry-with-the-same-key contract in the tool description as the join it actually is (it half does, at `tool-catalog.ts:702`).

**O9. The entry's tab is not in the URL.** *Recommendation:* move it to a path segment (`/repositories/7/rules`) or a `?tab=` param, so History and Scripts can be linked from a run failure or a Jira comment.

**O10. Re-activation silently overwrites the previous activation record.** `repository-catalog.ts:862-898`. *Recommendation:* append a settings-style version row for activation changes rather than upserting one state row.

**O11. The default-branch backfill is best effort and silent.** `import.ts:187-193` swallows the failure. *Recommendation:* keep it non-fatal, but surface "default branch unknown" on the row so an operator can see which rows the backfill never reached.

## 8. Anti-regression gates: where each MISSING row's test belongs

**Worker route tests** (`apps/worker/src/routes/api/v1/repository-catalog.test.ts`, pglite-backed):
- L18 activation with zero enabled through HTTP, asserting the refusal once the guard moves into `activateRepositoryCatalog`.
- L19 re-activation overwriting the state row, asserting what is kept.
- P11 `repositoryId: 0` onto an existing path over HTTP (reconcile, not a second row).
- P15 non-numeric route id answering 404.
- P22/P23 empty `gateGroups` and an unknown `gateGroups` reference refused at the profile route.
- P24 a `curl | sh` command accepted (or refused, once O6 is decided), pin the decision either way.
- P31 an empty `reason` minting an attributed-to-nobody version.
- P34 an unpaged versions response, with a fixture large enough to make the cliff visible.
- T01 the HTTP twin of the `repositories` group refusal.

**Service tests with pglite** (`apps/worker/src/services/repository-catalog/*.test.ts`):
- L13 the default-branch backfill, including the silent-failure path.
- P07 `changedFields: []` on a create, paired with `unchanged: false`.
- P10 a save with no `expectedProfileVersion` overwriting a concurrent edit (the documented behaviour, pinned).
- P29/P30 relationship self-reference, duplicates and unknown ids (a characterization test until O7 is decided).
- S07 a repository with no README and no manifests still producing a proposal.

**Engine tests** (`apps/worker/src/engine/`):
- R23 the sandbox lifetime sized against the ceiling at workspace creation, and an edit mid-run moving nothing in either direction (the `Math.max` half is already covered at `repository-catalog.test.ts:543`).
- R15 a stored run-start result with no `repositories` field resuming as the bridge, as an explicit characterization test in `run-carried-settings.test.ts`.
- R06/R08/R09/R10 the discovery and expansion refusals and their exact clarification texts, in a `repository-discovery/runner` test.
- R03 a pending delivery drained after the repository was disabled.

**Services / dispatch tests** (`apps/worker/src/services/triggers/polling/`):
- R05 a failing catalog read on a poll tick: assert `poll_repository_catalog_skipped` and that no dispatch happened, so the fail-closed behaviour is pinned rather than incidental.
- R04 a ticket trigger reaching dispatch with a disabled repository, pinning today's behaviour until O1 is decided.

**MCP tool tests** (`apps/worker/src/mcp/tools/repositories.test.ts`):
- M14 a `repositories.import_preview` block (roles, provider status, `inCatalog` marking).
- M17 the advertised-vs-enforced path schema.
- M12 a client registered before the configuration scopes existed, as a stored-client fixture.
- S17 the same-key-while-in-flight CONFLICT, asserted as the intended contract.

**Dashboard node tests** (`apps/dashboard/**`):
- U03 the loading fallback.
- U08 tab state in the URL (write the test first, then fix the routing).
- U12 the variable palette offering exactly the seven names, asserted against `REPOSITORY_RULES_VARIABLES` so the menu cannot drift from the renderer.
- U14 `deploy-pin-warning.tsx`, it currently has no test at all; assert the copy and that focus reaches the scope modal.
- U15 a 390 px render of the list and the entry.
- L25 the dashboard's missing zero-enabled warning, once the copy exists.

**E2E scenario** (`apps/worker/e2e/`, a new `catalog/` directory; there is nothing there today):
- One scenario walking import → enable → activate → dispatch → refuse-a-disabled-repository → run with rules injected, against a fixture deployment. This is the single highest-value addition: every seam in section 4 is currently proved only by unit tests on either side of it.

**Scheduling / golden fixture:**
- A golden fixture of the compiled prompt containing a `Repository rules for <owner/name>` section with all seven variables rendered, so a change to `effective-prompt.ts:268-270` or the variable set fails visibly rather than silently changing what the agent reads.
