# Repository scripts: UX truth and editor overhaul

Input: the 2026-08-26 three-skeptic UX audit (block panel, /scripts editor, cross-surface mental model) plus a live browser pass over production. Branch: `feat/repository-scripts-ux`.

## Problem

Three behavioral holes let a green run verify nothing (multi-repo undercoverage reports `allPassed: true`; Gate groups decides what runs, not what blocks, while the copy teaches the opposite; an empty Groups field means opposite things in `run_checks` and `run_scripts`). Around them, the block panel is a free-text textarea over a per-repository runtime, and /scripts renders every control expanded with repeated prose.

## Decisions

- Coverage becomes a first-class, additive output (`groupCoverage`: declaredIn/missing repos per selected group) plus a summary sentence. `allPassed` semantics do not change: partial coverage is legitimate (frontend lint + backend pytest in one block). No new status enum values (statusVariants widening trap).
- The Groups control becomes a checkbox list with a per-group repo coverage counter, modeled on the shipped GateGroupsEditor, with a validated free-text escape hatch for forward references.
- Gate section tells the truth: what you select is what runs at the gate; a newly added group joins an explicit selection automatically (with undo).
- Group name shape lives once in `@shared/contracts` (pattern, max length, message); worker zod and dashboard validation both consume it.
- `expandGroupCommands` moves to `@shared/contracts` so the editor can preview exactly what the worker will run.
- Block type ids never change; `run_checks` disappears from the palette only.

## Out of scope

Cross-definition "used by N blocks" back-references, inline repoPath editing, real dry-run execution in a sandbox, persisting script results past replay expiry, automatic rename propagation into deployed definitions.

## Stages

| # | Stage | File scope | Tier | Skeptic | TDD | DoD |
|---|-------|------------|------|---------|-----|-----|
| A | Worker truth: groupCoverage output + summary, allowedEnv in GET, expandGroupCommands to shared, group-name schema rewired to shared, registry/docs copy | apps/worker/src/{workflows/blocks/pre-pr-checks.ts,workflows/blocks/run-checks.ts,workflows/agent.ts,pre-pr-checks/*,routes/api/v1/pre-pr-checks.get.ts,workflow-definition/*}, apps/shared/contracts/repository-scripts.ts, docs/workflow-workspace/index.html | opus | yes | yes | touched worker vitest files green, worker typecheck |
| B | Block panels: coverage checkbox picker, catalog fetch states, per-block honest warnings, run_scripts Save validation, run_checks selection-mode UI, gate panel read-only summary, palette naming/hide | apps/dashboard/components/cockpit/flow-editor/*, apps/dashboard/components/cockpit/screens/workflow-editor.tsx, apps/dashboard/lib/workflow-editor/params.ts | opus | yes | yes | touched dashboard vitest files green, dashboard typecheck |
| C | /scripts structure: gate truth (radio, chips, auto-add), accordion + progressive disclosure, conditional prose | apps/dashboard/components/cockpit/screens/repository-scripts.tsx (+test) | opus | yes | yes | repository-scripts.test.tsx green, dashboard typecheck |
| D | /scripts flows: run-order preview, env allowlist picker, sticky save + nav guard, new-repo seed, paste split/reorder, remove confirms, repoPath validation, history preview/current, legacy chip, save-semantics line | apps/dashboard/components/cockpit/screens/repository-scripts.tsx (+test), apps/dashboard/app/(cockpit)/cockpit-shell.tsx (+test) | opus | yes | yes | targeted vitest files green, dashboard typecheck |
| E | Read surfaces: humanized status labels with tooltips, coverage gaps ("not reached") in replay/trace | apps/dashboard/components/cockpit/screens/workflow-replay.tsx, trace.tsx (+tests) | sonnet | no | no | targeted vitest files green, dashboard typecheck |

Order: A, B, C in parallel (disjoint files); D after A and C; E after A. Advisor commits per stage after review; wide verification via CI on the PR.
