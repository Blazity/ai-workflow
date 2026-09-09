# Prompt Editor UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the expanded prompt editor so it is larger, reads cleanly, preserves focus while typing, supports per-section insertion, and keeps Raw mode within the same layout bounds.

**Architecture:** Keep the current modal, Tiptap editor, prompt preview parser, and library rail. Separate modal lifetime cleanup from transient Escape-key state, keep parent callbacks stable, and fix flex sizing at the owning containers. Reuse `PromptPreview` for both library and built-in template typography so one semantic rhythm fixes both surfaces.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS 4, Tiptap 3, Node test runner.

## Global Constraints

- Expanded editor width is `94vw`, capped at `1240px`; maximum height is `90vh`.
- Preserve the current relative proportions of the library rail and editor pane.
- Add no markdown features or dependencies.
- Do not change the base inspector textarea outside the expanded modal.
- Keep edits limited to the prompt editor, prompt library preview, and their focused tests.
- Do not create production-code commits from the current dirty worktree because the scoped files already contain pre-existing user changes.

---

## File map

- `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`: owns stable open/close callbacks and the built-in template modal.
- `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`: owns modal lifetime, Escape handling, dimensions, and the two-panel flex layout.
- `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`: owns section cards and insert/append actions.
- `apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx`: owns shared WYSIWYG/Raw surface sizing.
- `apps/dashboard/components/cockpit/prompt-library/prompt-preview.tsx`: emits semantic markdown preview markup.
- `apps/dashboard/app/globals.css`: owns shared editor and preview typography rhythm.
- `apps/dashboard/lib/prompt-library/sections.test.ts`: verifies that individual section bodies remain exact insertion units.

### Task 1: Stabilize modal focus lifecycle

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx:66-79,329-336`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx:43-72`
- Test: browser interaction against the expanded prompt editor

**Interfaces:**
- Consumes: `PromptEditorModal.onClose: () => void`, `PromptEditorModal.onChange: (markdown: string) => void`.
- Produces: a stable `closeExpandedEditor: () => void`; focus restoration tied only to actual modal lifetime.

- [ ] **Step 1: Capture the failing focus behavior**

Open an editable agent prompt, click `Expand`, place the caret in the WYSIWYG body, and type `abc`.

Expected before the fix: after a character, focus moves to the underlying `Expand` button or another page control. Record the focused element with `document.activeElement` in the browser inspector.

- [ ] **Step 2: Stabilize the parent close callback**

Add alongside the existing stable dismiss handlers in `PromptField`:

```tsx
const closeExpandedEditor = useCallback(() => setExpandOpen(false), []);
```

Pass it to the modal:

```tsx
<PromptEditorModal
  open={expandOpen && !disabled}
  onClose={closeExpandedEditor}
  value={value}
  onChange={setBodyValue}
  onInsert={applyInsertPayload}
  blockName={node.name || node.type}
  fieldLabel={label}
/>
```

- [ ] **Step 3: Split lifetime cleanup from transient Escape handling**

In `PromptEditorModal`, keep body scroll locking, opener capture, and focus restoration in an effect that reacts only to `open`. Store the latest `onClose` callback in a ref so modal lifetime does not restart when callback identity changes:

```tsx
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;

useEffect(() => {
  if (!open) return;
  restoreFocus.current = document.activeElement as HTMLElement | null;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => {
    document.body.style.overflow = prevOverflow;
    restoreFocus.current?.focus?.();
  };
}, [open]);
```

Put only the Escape listener in a second effect:

```tsx
useEffect(() => {
  if (!open) return;
  const onEsc = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || saveOpen) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (libOpen) setLibOpen(false);
    else onCloseRef.current();
  };
  window.addEventListener("keydown", onEsc, { capture: true });
  return () => window.removeEventListener("keydown", onEsc, { capture: true });
}, [open, libOpen, saveOpen]);
```

- [ ] **Step 4: Verify focus and Escape behavior**

Run:

```bash
pnpm --filter ai-workflow-dashboard typecheck
```

Expected: exit 0.

In the browser, verify:

1. Typing several characters keeps `document.activeElement` inside `.ProseMirror`.
2. Opening and closing the library does not focus the page behind the modal.
3. First Escape closes the library; second Escape closes the modal.
4. Closing the modal returns focus to `Expand`.

- [ ] **Step 5: Review the focused focus diff**

```bash
git diff --check -- apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx
git diff -- apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx
```

Expected: no whitespace errors and no changes outside modal focus lifecycle.

### Task 2: Make the modal and both editor modes fill their bounds

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx:78-127`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx:226-296`
- Test: browser layout at 1440 px, 1280 px, and 1024 px viewport widths

**Interfaces:**
- Consumes: `PromptEditor.fill?: boolean`.
- Produces: one full-width, full-height editor shell shared by WYSIWYG and Raw modes.

- [ ] **Step 1: Capture the failing Raw layout**

Open the expanded editor with the library visible, toggle `Raw`, and inspect the editor root and textarea bounds.

Expected before the fix: the editor root or textarea uses only its intrinsic content width instead of the remaining pane width.

- [ ] **Step 2: Apply the approved modal dimensions and proportional rail**

Change the dialog sizing in `PromptEditorModal` to:

```tsx
className={`flex h-[90vh] max-h-[90vh] w-[94vw] max-w-[1240px] flex-col overflow-hidden ...`}
```

Change the horizontal content row and rail sizing to allow both panes to shrink correctly while preserving the current approximately 40/60 split:

```tsx
<div className="flex min-h-0 min-w-0 flex-1">
  <div className={`min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] ... ${
    libOpen ? "w-[40%] border-r border-neutral-200" : "w-0"
  }`}>
    <div className="h-full w-full min-w-0">
      <PromptLibraryRail ... />
    </div>
  </div>
  <div className="flex min-h-0 min-w-0 flex-1 p-4">
    <PromptEditor ... />
  </div>
</div>
```

- [ ] **Step 3: Make the editor shell own the full pane width**

Add `w-full min-w-0` to the `PromptEditor` root:

```tsx
<div
  className={`flex w-full min-w-0 flex-col overflow-hidden rounded-[3px] border border-neutral-200 bg-panel ${
    fill ? "h-full min-h-0" : ""
  }`}
>
```

Keep the Raw textarea as `w-full min-w-0 flex-1 resize-none` when `fill` is enabled. Keep WYSIWYG in the same scroll-owning flex slot.

- [ ] **Step 4: Verify responsive bounds**

At 1440 px, 1280 px, and 1024 px viewport widths verify:

1. Modal width is `min(94vw, 1240px)` and height is at most `90vh`.
2. Opening the rail preserves an approximately 40/60 split.
3. WYSIWYG and Raw have identical outer bounds.
4. Long unbroken code and markdown scroll inside their surface without expanding the modal.

Run:

```bash
pnpm --filter ai-workflow-dashboard typecheck
```

Expected: exit 0.

- [ ] **Step 5: Review the focused layout diff**

```bash
git diff --check -- apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx
git diff -- apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx
```

Expected: no whitespace errors and only approved modal/editor sizing changes.

### Task 3: Polish markdown rhythm and section actions

**Files:**
- Modify: `apps/dashboard/components/cockpit/prompt-library/prompt-preview.tsx:36-102`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx:188-211`
- Modify: `apps/dashboard/app/globals.css:228-366`
- Test: `apps/dashboard/lib/prompt-library/sections.test.ts`

**Interfaces:**
- Consumes: `PromptPreview({ body, maxHeightClass })`, `PromptSection.body`, `targetHasContent`.
- Produces: `.ck-markdown-preview` semantic spacing and a per-section action whose label reflects insert versus append mode.

- [ ] **Step 1: Add a failing exact-section regression test**

Append to `sections.test.ts`:

```ts
test("a selected section body contains only that heading and its content", () => {
  const body = "# First\nalpha\n\n## Second\nbeta\n\n# Third\ngamma";
  const sections = splitSections(body);
  assert.equal(sections[1].title, "Second");
  assert.equal(sections[1].body, "## Second\nbeta\n\n");
  assert.equal(sections[1].body.includes("# Third"), false);
});
```

- [ ] **Step 2: Run the focused test and assess RED**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test apps/dashboard/lib/prompt-library/sections.test.ts
```

Expected: the new test must fail if section boundaries include neighboring content. If it already passes, retain it as regression coverage because the requested insert behavior is already implemented and proceed without changing `splitSections`.

- [ ] **Step 3: Give previews a semantic wrapper**

In `PromptPreview`, replace the generic gap container with:

```tsx
<div className="ck-markdown-preview">
  {blocks.map((block, index) => (
    <Block key={index} block={block} />
  ))}
</div>
```

Remove per-heading `mt-*` and per-block font size/line-height utilities that conflict with the wrapper rhythm. Retain structural utilities for lists, code overflow, borders, colors, and variable marks.

- [ ] **Step 4: Define one compact preview rhythm and tune WYSIWYG to match**

Add focused global rules:

```css
.ck-markdown-preview {
  color: #34383f;
  font-family: var(--font-body);
  font-size: 12.5px;
  line-height: 1.62;
  overflow-wrap: anywhere;
}
.ck-markdown-preview > * { margin: 0; }
.ck-markdown-preview > * + * { margin-top: 0.72em; }
.ck-markdown-preview > * + h1,
.ck-markdown-preview > * + h2,
.ck-markdown-preview > * + h3 { margin-top: 1.35em; }
.ck-markdown-preview > h1 + *,
.ck-markdown-preview > h2 + *,
.ck-markdown-preview > h3 + * { margin-top: 0.42em; }
.ck-markdown-preview h1,
.ck-markdown-preview h2,
.ck-markdown-preview h3 {
  color: #181b20;
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.ck-markdown-preview h1 { font-size: 17px; }
.ck-markdown-preview h2 { font-size: 14.5px; }
.ck-markdown-preview h3 { font-size: 13px; }
```

Adjust `.ck-prose` to `font-size: 13px`, keep `line-height: 1.65`, and align its heading-before/heading-after spacing to the same `1.35em`/`0.42em` rhythm.

- [ ] **Step 5: Make the section action explicit and keyboard-visible**

Derive the label inside the section map:

```tsx
const sectionActionLabel = targetHasContent ? "Append section" : "Insert section";
```

Update the button to include `aria-label={sectionActionLabel}`, visible text matching that label, and these visibility states:

```tsx
className="... opacity-0 pointer-events-none transition-[opacity,transform] duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus:opacity-100 focus:pointer-events-auto"
```

Give the section wrapper a little top/right action clearance without changing its normal content width, and keep `onClick={() => insertSection(section.body)}` so only the selected section is inserted.

- [ ] **Step 6: Run tests and type checking**

Run:

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
```

Expected: both commands exit 0 with no new warnings.

- [ ] **Step 7: Verify the complete UX in the browser**

Verify both a library prompt and a built-in default template:

1. H1/H2/H3, paragraphs, lists, inline code, and code blocks have visible semantic spacing.
2. Library preview text is compact enough for the rail and does not visually overpower the editor.
3. Hovering a section reveals `Append section` for a non-empty target.
4. Tabbing to the action keeps it visible; activating it inserts only that section.
5. WYSIWYG and Raw remain stable after insertion and continued typing.

- [ ] **Step 8: Review the focused typography and section diff**

```bash
git diff --check -- apps/dashboard/components/cockpit/prompt-library/prompt-preview.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/app/globals.css apps/dashboard/lib/prompt-library/sections.test.ts
git diff -- apps/dashboard/components/cockpit/prompt-library/prompt-preview.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/app/globals.css apps/dashboard/lib/prompt-library/sections.test.ts
```

Expected: no whitespace errors and only approved typography, section-action, and regression-test changes.

### Task 4: Final regression verification

**Files:**
- Verify only; modify a scoped file only if a failing check identifies a regression caused by Tasks 1-3.

**Interfaces:**
- Consumes: completed focus, layout, preview, and section-action changes.
- Produces: verified dashboard behavior with no unrelated changes.

- [ ] **Step 1: Run the dashboard quality suite**

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
```

Expected: all commands exit 0.

- [ ] **Step 2: Check the focused diff**

```bash
git diff --check
git status --short
git diff -- apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx apps/dashboard/components/cockpit/prompt-library/prompt-preview.tsx apps/dashboard/app/globals.css apps/dashboard/lib/prompt-library/sections.test.ts
```

Expected: no whitespace errors; every changed production line traces to the approved prompt editor polish.

- [ ] **Step 3: Run the final browser flow**

Open the expanded prompt editor, type in WYSIWYG, open the library, append one section, toggle Raw, type again, return to WYSIWYG, close the modal, and open the built-in template.

Expected: focus stays in the active surface, the modal remains bounded at `94vw`/`1240px`/`90vh`, only the chosen section is appended, both modes fill the same pane, focus returns to `Expand` on close, and template typography matches the library preview.
