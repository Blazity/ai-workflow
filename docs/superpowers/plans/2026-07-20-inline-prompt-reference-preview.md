# Inline Prompt Reference Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous rail-navigation Preview action with an inline, read-only expansion of resolved prompt references and polish the reference card/menu at narrow and wide widths.

**Architecture:** Add a pure reference-body resolver shared by expansion and detach. Rebuild `PromptReferenceChips` as responsive reference cards with independent expansion state and a portal-based mutation menu; keep the library rail initial selection for the full editor, but remove Preview-as-navigation plumbing.

**Tech Stack:** React 19, Next.js 15 App Router, TypeScript, Tailwind CSS, Node test runner through `tsx --test`.

## Global Constraints

- `Show content` is presentation-only and must never call workflow `onChange`.
- Referenced content is always read-only until `Detach and edit` replaces the token.
- Multiple references may be expanded simultaneously.
- Pinned references render the exact pinned version, never a latest fallback.
- The `···` menu must render above all `overflow-hidden` composer surfaces.
- Read-only mode retains Show/Hide content and Open in library while hiding all mutation actions.
- Missing references expose no Show/Open/menu actions.
- Do not add dependencies or change runtime prompt resolution.
- Preserve unrelated dirty changes in `apps/dashboard/package.json` and `pnpm-lock.yaml`.

---

### Task 1: Reference Preview Resolution

**Files:**
- Create: `apps/dashboard/lib/prompt-library/reference-preview.ts`
- Create: `apps/dashboard/lib/prompt-library/reference-preview.test.ts`

**Interfaces:**
- Consumes: `ParsedPromptReference`, `PromptLibraryListRowDto`, and optional `PromptLibraryDetailResponse` from `@shared/contracts`.
- Produces: `resolveReferencePreview(reference, row, detail?)` returning `{ kind: "ready"; body: string } | { kind: "needs-detail" } | { kind: "missing-version" }`.

- [ ] **Step 1: Write failing resolver tests**

Cover latest/current bodies, historical detail bodies, a historical reference without detail, and a detail response without the requested version.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/reference-preview.test.ts`

Expected: FAIL because `reference-preview.ts` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Use the list-row body only for `latest` or `reference.version === row.currentVersion`. Historical pinned references must return `needs-detail` until detail exists, then exact-match the requested version or return `missing-version`.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused resolver test and `pnpm --filter ai-workflow-dashboard typecheck`.

Commit: `feat(dashboard): resolve inline reference previews`

### Task 2: Responsive Expandable Reference Card

**Files:**
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.test.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`

**Interfaces:**
- Consumes: `resolveReferencePreview(...)` from Task 1 and the existing `PromptPreview` Markdown renderer.
- Produces: responsive reference cards whose Show/Hide state is internal and whose menu is rendered with `createPortal`.

- [ ] **Step 1: Add failing SSR/contract tests**

Assert the resolved card contains `Live reference`, `Show content`, `/prompts?prompt=7`, full-width/wrapping layout classes, and no old `Preview` copy. Assert read-only cards omit `More actions`, while missing references omit Show/Open/menu actions.

- [ ] **Step 2: Verify RED**

Run the component and reference-navigation tests; expect failures on the new copy/layout contract.

- [ ] **Step 3: Implement inline expansion**

Track expanded reference keys independently. Resolve current bodies immediately, lazy-fetch historical detail once per prompt, render loading/error/missing-version states, and render ready bodies through `PromptPreview` inside a labelled read-only surface. Expansion must not call `onChange`.

- [ ] **Step 4: Implement the portal mutation menu**

Anchor the portal to the `···` trigger's bounding rect, clamp it to the viewport, close on outside pointer-down and Escape, restore trigger focus, and keep Pin/Follow plus `Detach and edit` as the only menu entries.

- [ ] **Step 5: Remove Preview-as-rail-navigation plumbing**

Remove `onPreview` / `onPreviewReference` callbacks from chips and composer. Derive a single initial reference target when the full editor opens so the left rail remains contextually selected without an explicit Preview action.

- [ ] **Step 6: Verify and commit**

Run focused TSX tests, all dashboard tests, typecheck, and `git diff --check`.

Commit: `feat(dashboard): expand live references inline`

### Task 3: Final UX and Regression Review

**Files:**
- Review all Task 1-2 files without unrelated refactoring.

- [ ] **Step 1: Review behavior against the approved design**

Trace every handler and confirm only Pin, Follow, and Detach call `onChange`; verify pinned historical resolution never falls back to the row body.

- [ ] **Step 2: Review visual mechanics**

Confirm consistent control heights, tabular versions, wrapping at 320px, minimum hit areas, specific transitions, portal z-index above the modal, and no clipping ancestor around the menu.

- [ ] **Step 3: Run fresh complete verification**

Run: `pnpm --filter ai-workflow-dashboard test && pnpm --filter ai-workflow-dashboard typecheck && pnpm --filter ai-workflow-dashboard build && git diff --check`

Expected: all tests, typecheck, build, and whitespace checks pass.

- [ ] **Step 4: Verify scoped history and preserved user changes**

Run: `git log -8 --oneline && git status --short`.

Expected: feature commits are on `feat/prompt-center`; only `apps/dashboard/package.json` and `pnpm-lock.yaml` remain dirty outside the feature.
