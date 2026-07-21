# Compact Prompt Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workflow inspector's small prompt textarea and duplicate library action with a compact prompt summary that opens the full editor modal for editing or read-only viewing.

**Architecture:** Add a pure summary-model function so reference, custom, implicit-default, and empty states are deterministic and unit-tested. `PromptField` renders that model as a compact card and keeps the existing modal as the sole editing surface. Read-only state flows from `PromptField` through `PromptEditorModal` into the composer and library rail so viewing remains available while all mutations are disabled.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Node test runner through `tsx --test`.

## Global Constraints

- Remove the inline prompt textarea from every `PromptField` usage.
- Remove the separate inspector `Library` action.
- Do not mutate workflow data merely by opening the modal.
- Keep implicit live references as `Latest` unless the user explicitly changes them.
- In non-editable workflows, allow viewing but disable every prompt mutation.
- Do not add dependencies or refactor unrelated inspector fields.

---

### Task 1: Compact Prompt Summary and Inspector Card

**Files:**
- Create: `apps/dashboard/lib/prompt-library/prompt-inspector-summary.ts`
- Create: `apps/dashboard/lib/prompt-library/prompt-inspector-summary.test.ts`
- Create: `apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.tsx`
- Create: `apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`

**Interfaces:**
- Consumes: `parsePromptReferenceTokens(value)`, `PromptLibraryListRowDto`, and the existing `effectiveDefaultPromptValue(...)` result.
- Produces: `promptInspectorSummary(value, effectiveValue, implicitName, rows): PromptInspectorSummary`, where the union has `kind`, `title`, `detail`, and optional `preview`.

- [ ] **Step 1: Write failing summary-model tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { promptInspectorSummary } from "./prompt-inspector-summary";

function row(id: number, name: string, currentVersion: number): PromptLibraryListRowDto {
  return {
    id,
    name,
    description: null,
    tags: [],
    currentVersion,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "System",
    body: "# Prompt",
  };
}

test("summarizes a latest reference", () => {
  assert.deepEqual(
    promptInspectorSummary("{{prompt:7}}", "{{prompt:7}}", undefined, [row(7, "research-plan", 2)]),
    { kind: "reference", title: "research-plan", detail: "Latest · v2" },
  );
});

test("summarizes a pinned reference", () => {
  assert.deepEqual(
    promptInspectorSummary("{{prompt:7@1}}", "{{prompt:7@1}}", undefined, [row(7, "research-plan", 2)]),
    { kind: "reference", title: "research-plan", detail: "Pinned v1" },
  );
});

test("summarizes custom and empty prompts", () => {
  assert.deepEqual(
    promptInspectorSummary("First line\nSecond line", "First line\nSecond line", undefined, []),
    { kind: "custom", title: "Custom prompt", detail: "22 chars · ~6 tokens", preview: "First line Second line" },
  );
  assert.deepEqual(promptInspectorSummary("", "", undefined, []), {
    kind: "empty",
    title: "No prompt configured",
    detail: "Open the editor to add one",
  });
});

test("keeps an unavailable implicit default visible", () => {
  assert.deepEqual(promptInspectorSummary("", "", "research-plan", []), {
    kind: "reference",
    title: "research-plan",
    detail: "Latest",
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/prompt-inspector-summary.test.ts`

Expected: FAIL because `prompt-inspector-summary.ts` does not exist.

- [ ] **Step 3: Implement the pure summary model**

```ts
export type PromptInspectorSummary = {
  kind: "reference" | "custom" | "empty";
  title: string;
  detail: string;
  preview?: string;
};

export function promptInspectorSummary(
  value: string,
  effectiveValue: string,
  implicitName: string | undefined,
  rows: readonly PromptLibraryListRowDto[],
): PromptInspectorSummary {
  const trimmed = effectiveValue.trim();
  const references = parsePromptReferenceTokens(trimmed);
  const onlyReference = references.length === 1 && references[0].raw === trimmed;
  if (onlyReference) {
    const reference = references[0];
    const row = rows.find((candidate) => candidate.id === reference.promptId);
    return {
      kind: "reference",
      title: row?.name ?? implicitName ?? `Missing prompt ${reference.promptId}`,
      detail: reference.version === "latest"
        ? `Latest${row ? ` · v${row.currentVersion}` : ""}`
        : `Pinned v${reference.version}`,
    };
  }
  if (value.trim()) {
    return {
      kind: "custom",
      title: "Custom prompt",
      detail: `${value.length} chars · ~${Math.ceil(value.length / 4)} tokens`,
      preview: value.replace(/\s+/g, " ").trim(),
    };
  }
  if (implicitName) return { kind: "reference", title: implicitName, detail: "Latest" };
  return { kind: "empty", title: "No prompt configured", detail: "Open the editor to add one" };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/prompt-inspector-summary.test.ts`

Expected: all four tests pass.

- [ ] **Step 5: Write and run failing compact-card component tests**

Create `prompt-inspector-card.test.tsx` using React's existing server renderer, with no DOM-test dependency:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInspectorCard } from "./prompt-inspector-card";

test("renders editable custom summary without an inline textarea or Library action", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled={false}
      summary={{ kind: "custom", title: "Custom prompt", detail: "12 chars · ~3 tokens", preview: "Do the work" }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /Edit prompt/);
  assert.match(html, /Do the work/);
  assert.doesNotMatch(html, /<textarea|Library/);
});

test("renders a read-only reference card as a dialog trigger", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled
      summary={{ kind: "reference", title: "research-plan", detail: "Latest · v2" }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /View prompt/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /research-plan/);
});
```

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test components/cockpit/flow-editor/prompt-inspector-card.test.tsx`

Expected: FAIL because `prompt-inspector-card.tsx` does not exist.

- [ ] **Step 6: Implement the compact card and replace inline editing UI**

Create `PromptInspectorCard` as the presentational button described below, then use it from `PromptField`.

In `PromptField`:

- remove the textarea, `Expand`, inspector `Library`, inspector save action, variable picker, and inline character counter;
- remove state and handlers used only by those deleted controls;
- retain `applyInsertPayload`, `setBodyValue`, effective-default calculation, provenance/reference rendering, and modal state;
- derive the summary with `promptInspectorSummary(value, effectiveValue, defaultPromptName, rows)`;
- render a full-width button with a two-line-clamped preview, summary title/detail, and `Edit prompt` or `View prompt` copy;
- open the modal when the button is clicked without writing through `onChange`.

The card button must use this structure so it is keyboard accessible without nesting reference action buttons inside it:

```tsx
<button
  type="button"
  aria-haspopup="dialog"
  aria-label={`${disabled ? "View" : "Edit"} ${label}`}
  onClick={() => setExpandOpen(true)}
  className="group w-full rounded-[3px] border border-neutral-200 bg-off-white p-2.5 text-left hover:border-mariner-200 hover:bg-mariner-100"
>
  <span className="flex items-start gap-2">
    <span className="min-w-0 flex-1">
      <span className="block truncate font-mono text-[11px] font-semibold text-coal">{summary.title}</span>
      <span className="mt-0.5 block font-mono text-[9px] uppercase text-neutral-500">{summary.detail}</span>
    </span>
    <span className="font-mono text-[9px] uppercase text-mariner">{disabled ? "View prompt" : "Edit prompt"}</span>
  </span>
  {summary.preview && <span className="mt-2 line-clamp-2 block font-body text-[11px] leading-[1.45] text-neutral-600">{summary.preview}</span>}
</button>
```

Render existing reference/provenance controls below the button, outside it.

- [ ] **Step 7: Run focused tests and dashboard typecheck**

Run: `pnpm --filter ai-workflow-dashboard test && pnpm --filter ai-workflow-dashboard typecheck`

Expected: all dashboard tests pass and TypeScript exits with code 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/dashboard/lib/prompt-library/prompt-inspector-summary.ts apps/dashboard/lib/prompt-library/prompt-inspector-summary.test.ts apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.tsx apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.test.tsx apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx
git commit -m "feat(dashboard): compact prompt inspector"
```

### Task 2: Read-Only Prompt Modal

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`

**Interfaces:**
- Consumes: `PromptField.disabled`.
- Produces: `PromptEditorModal.disabled: boolean` and `PromptLibraryRail.disabled?: boolean`; the existing `PromptSectionComposer.disabled?: boolean` is reused.

- [ ] **Step 1: Add the read-only prop flow**

Pass `disabled={disabled}` from `PromptField` into `PromptEditorModal`. Add the required boolean prop to the modal and pass it to both child surfaces:

```tsx
<PromptLibraryRail
  disabled={disabled}
  onInsert={handleLibraryInsert}
  targetHasContent={hasContent}
/>
<PromptSectionComposer
  value={value}
  onChange={onChange}
  disabled={disabled}
  syncRequest={syncRequest}
/>
```

Remove the current `!disabled` restriction from the modal's `open` prop in `PromptField` so read-only viewing works.

- [ ] **Step 2: Make modal chrome read-only-safe**

In `PromptEditorModal`:

- set the dialog label to `${disabled ? "View" : "Edit"} ${fieldLabel}`;
- hide the modal `Save` button when disabled;
- keep `Close`, Raw/Visual switching, library browsing, focus restoration, and Escape behavior available;
- make `handleLibraryInsert` return immediately when disabled.

```ts
const handleLibraryInsert = useCallback((payload: PromptInsertPayload) => {
  if (disabled) return;
  onInsert(payload);
  syncRequestId.current += 1;
  setSyncRequest({ id: syncRequestId.current, mode: payload.mode });
}, [disabled, onInsert]);
```

- [ ] **Step 3: Disable library mutations**

Add `disabled?: boolean` to `PromptLibraryRail`. Keep search, tag filtering, version selection, and prompt/section preview active. For mutation affordances:

- use `draggable={!disabled}` on prompt and section handles;
- do not render section insert buttons or the bottom `Copy text` / `Pin` / `Use latest` action bar when disabled;
- guard `copyWhole`, `insertReference`, and `insertSection` with `if (disabled) return`.

```tsx
{!disabled && (
  <div className="flex shrink-0 items-center gap-2 border-t border-neutral-200 bg-off-white px-3 py-2">
    {/* existing Copy text, Pin, and Use latest buttons */}
  </div>
)}
```

- [ ] **Step 4: Prevent composer mutations in read-only Visual mode**

`PromptSectionComposer` already disables Raw editing, adding sections, and drops. Complete read-only behavior by:

- disabling the move and remove buttons when `disabled`;
- making section preview buttons non-editing when `disabled`;
- keeping Raw/Visual switching available;
- ensuring drag handles have `draggable={!disabled}` and cannot initiate mutation.

```tsx
<button
  type="button"
  disabled={disabled || index === 0}
  onClick={() => commit(moveComposerBlock(blocks, block.id, index - 1))}
  className={iconButton}
  aria-label="Move up"
>
  ↑
</button>
```

- [ ] **Step 5: Verify the dashboard**

Run: `pnpm --filter ai-workflow-dashboard test`

Expected: all dashboard tests pass.

Run: `pnpm --filter ai-workflow-dashboard typecheck`

Expected: TypeScript exits with code 0.

Run: `pnpm --filter ai-workflow-dashboard build`

Expected: Next.js production build exits with code 0.

- [ ] **Step 6: Manual UX verification**

Run: `pnpm --filter ai-workflow-dashboard dev` and inspect planning, implementation, review, generic agent, and call-LLM nodes.

Expected:

- the inspector contains no small prompt textarea and no separate `Library` action;
- the card clearly distinguishes latest, pinned, custom, and empty states;
- editable cards open a fully functional editor;
- read-only cards open the modal but cannot change, insert, move, remove, detach, pin, or save prompt content;
- closing the modal restores focus to the card.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx
git commit -m "feat(dashboard): support read-only prompt viewing"
```

### Task 3: Final Review

**Files:**
- Review only the files changed in Tasks 1 and 2.

**Interfaces:**
- Consumes: the compact inspector and read-only modal behavior.
- Produces: a verified implementation with no additional code changes unless review finds a defect.

- [ ] **Step 1: Review the diff against the approved spec**

Run: `git diff HEAD~2 -- apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.tsx apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.test.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx apps/dashboard/lib/prompt-library/prompt-inspector-summary.ts apps/dashboard/lib/prompt-library/prompt-inspector-summary.test.ts`

Expected: every changed line maps to compact inspector, modal-only editing, read-only safety, or its tests.

- [ ] **Step 2: Check formatting and repository state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; unrelated pre-existing dashboard changes remain untouched.

- [ ] **Step 3: Re-run final verification if review changed code**

Run: `pnpm --filter ai-workflow-dashboard test && pnpm --filter ai-workflow-dashboard typecheck && pnpm --filter ai-workflow-dashboard build`

Expected: tests, TypeScript, and production build all pass.
