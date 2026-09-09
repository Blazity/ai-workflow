# Prompt Reference Sidebar Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicate live-reference card from the compact prompt inspector and expose `Detach and edit` directly on editable reference cards in the full prompt editor.

**Architecture:** Keep `PromptInspectorCard` as the compact inspector's only prompt representation. Reuse the existing detach callback in `PromptReferenceChipsView`, moving its trigger into the primary action row while reducing `PromptReferenceActionsMenu` to version management only.

**Tech Stack:** React 19, Next.js 15, TypeScript, Tailwind CSS, Node test runner with `tsx`, server-side React markup tests.

## Global Constraints

- Work directly on `feat/prompt-center`; do not create a worktree.
- Do not modify or stage the user's existing `apps/dashboard/package.json` and `pnpm-lock.yaml` changes.
- Keep copied-prompt provenance, reference resolution, version pinning, detachment semantics, left-rail selection, and library deep links unchanged.
- Add no dependencies and do not redesign adjacent inspector controls.

---

### Task 1: Simplify prompt-reference presentation and actions

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`
- Create: `apps/dashboard/components/cockpit/flow-editor/prompt-field.test.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-actions-menu.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.test.tsx`

**Interfaces:**
- Consumes: existing `PromptReferenceChipsView` `value`, `rows`, `onChange`, and `disabled` props; existing `detach(reference, row, key)` behavior.
- Produces: a compact `PromptField` without inline `PromptReferenceChips`; an editable reference action row with a direct `Detach and edit` button; a menu whose props and contents cover only Pin/Follow.

- [ ] **Step 1: Add failing sidebar and editable-action regression tests**

Create an SSR test that renders a `PromptField` containing `{{prompt:7}}` and asserts that the compact inspector does not emit `aria-label="Prompt references"`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowNodeDef } from "@/lib/flows";
import { PromptField } from "./prompt-field";

test("compact prompt field does not duplicate live reference cards", () => {
  const node: FlowNodeDef = {
    id: "research",
    type: "call_llm",
    name: "Research",
    x: 0,
    y: 0,
    params: { prompt: "{{prompt:7}}" },
  };
  const html = renderToStaticMarkup(
    <PromptField
      label="Prompt"
      paramKey="prompt"
      node={node}
      disabled={false}
      onChange={() => {}}
    />,
  );

  assert.match(html, /aria-label="Edit Prompt"/);
  assert.doesNotMatch(html, /aria-label="Prompt references"/);
});
```

Extend `prompt-reference-chips.test.tsx` with an editable-card case that expects `Detach and edit` in static markup while preserving `More actions`, `Show content`, and the prompt-library link.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test \
  components/cockpit/flow-editor/prompt-field.test.tsx \
  components/cockpit/prompt-editor/prompt-reference-chips.test.tsx
```

Expected: the new sidebar test fails because `PromptField` still renders `PromptReferenceChips`, and the editable-card test fails because detach is not present until the client-only menu opens.

- [ ] **Step 3: Apply the minimal presentation changes**

In `prompt-field.tsx`, remove the `PromptReferenceChips` import and the entire duplicate live-reference/implicit-reference conditional between `PromptInspectorCard` and `provenance`. Keep `setBodyValue`, provenance, and `initialPreviewTarget` because the modal still uses them.

In `prompt-reference-chips.tsx`, add a direct editable action:

```tsx
{capabilities.canMutate && (
  <button
    type="button"
    disabled={busyKey === key}
    onClick={() => void detach(reference, row, key)}
    className={quietAction}
  >
    {busyKey === key ? "Detaching…" : "Detach and edit"}
  </button>
)}
```

Keep the overflow trigger for Pin/Follow. Remove `busy` and `onDetach` from the `PromptReferenceActionsMenu` invocation and component props, then remove the divider and detach menu item from the portal.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused command from Step 2.

Expected: all focused tests pass with zero failures.

- [ ] **Step 5: Run full dashboard verification**

Run:

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
git diff --check
```

Expected: all tests pass, TypeScript exits 0, the Next.js production build exits 0, and `git diff --check` prints no errors.

- [ ] **Step 6: Review and commit the implementation**

Review the diff against the design requirements, confirm only the five scoped dashboard files changed, and confirm the pre-existing package files remain unstaged. Then commit only the implementation files:

```bash
git add \
  apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx \
  apps/dashboard/components/cockpit/flow-editor/prompt-field.test.tsx \
  apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.tsx \
  apps/dashboard/components/cockpit/prompt-editor/prompt-reference-actions-menu.tsx \
  apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.test.tsx
git commit -m "refactor(dashboard): simplify prompt reference controls"
```
