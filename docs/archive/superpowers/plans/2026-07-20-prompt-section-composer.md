# Prompt Section Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a section-card prompt composer that accepts exact-position drops from the prompt library, supports reordering, and preserves markdown, focus, and scroll behavior.

**Architecture:** Keep markdown as the persisted value while a provider owns a locally stable `ComposerSection[]` view model. Pure functions parse, serialize, insert, edit, remove, and move cards; a modal-wide dnd-kit context connects library sources to the right-side sortable list. Reuse Tiptap through extracted toolbar and surface components so each card is independently editable while one pinned toolbar targets the active card.

**Tech Stack:** React 19, TypeScript, Next.js 15, Tiptap 3.28, Tailwind CSS 4, dnd-kit (`@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2), Node test runner via `tsx`.

## Global Constraints

- Markdown remains the only persisted prompt format; do not add a JSON section schema or migration.
- Every H1, H2, and H3 boundary returned by `splitSections` is one flat card.
- Duplicate titles are valid and must never merge or replace automatically.
- Whole-prompt drops insert all source sections as one ordered block at the exact drop position.
- Keep `Replace all`, `Add to end`, and click-based per-section insertion available.
- Raw mode remains a single full-width markdown textarea and reparses cards when returning to Visual mode.
- Typing, cancelled drags, and successful drops must not reset the modal or composer scroll to the top.
- Drag handles must support pointer and keyboard input; card menus must also provide `Move up` and `Move down`.
- Preserve fenced code, variables, lists, heading levels, and inline markdown through parse/serialize cycles.
- Use the existing neutral surfaces, mariner focus color, compact radius, standard easing, and reduced-motion behavior.
- Work in the existing checkout; do not create or switch to a git worktree.
- Do not modify unrelated dirty files or commit changes outside the files explicitly staged for each task.

## File map

- Create `apps/dashboard/lib/prompt-library/section-composer.ts`: pure section view-model and markdown mutation functions.
- Create `apps/dashboard/lib/prompt-library/section-composer.test.ts`: exact parse/insert/reorder/edit/remove regression tests.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-toolbar.tsx`: reusable pinned toolbar for the active Tiptap editor and Raw toggle.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-editor-surface.tsx`: reusable toolbar-free Tiptap editing surface for one card.
- Modify `apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx`: recompose the existing editor from the extracted toolbar and surface without changing its public behavior.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer-context.tsx`: stable section state, raw/visual state, dnd-kit provider, and mutations.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.ts`: shared drag payloads and pure drop-index resolution.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.test.ts`: drag payload and before/after target regression tests.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx`: sortable card, handle, editor surface, and accessible actions.
- Create `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`: right-side toolbar, card list, empty state, drop indicator, and Raw textarea.
- Modify `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`: draggable whole-prompt and section sources while retaining click actions.
- Modify `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`: mount one composer provider around both panes and route existing insert requests through it.
- Modify `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`: separate modal text updates from replace-provenance updates.
- Modify `apps/dashboard/package.json` and `pnpm-lock.yaml`: add the three pinned dnd-kit packages.

---

### Task 1: Pure section composer model

**Files:**
- Create: `apps/dashboard/lib/prompt-library/section-composer.ts`
- Create: `apps/dashboard/lib/prompt-library/section-composer.test.ts`

**Interfaces:**
- Consumes: `splitSections(markdown: string): PromptSection[]` from `apps/dashboard/lib/prompt-library/sections.ts`.
- Produces: `ComposerSection`, `SectionIdFactory`, `parseComposerSections`, `serializeComposerSections`, `insertComposerMarkdown`, `moveComposerSection`, `updateComposerSection`, and `removeComposerSection`.

- [ ] **Step 1: Write the failing model tests**

Create `section-composer.test.ts` with deterministic IDs and explicit markdown expectations:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertComposerMarkdown,
  moveComposerSection,
  parseComposerSections,
  removeComposerSection,
  serializeComposerSections,
  updateComposerSection,
} from "./section-composer.ts";

function ids() {
  let next = 0;
  return () => `section-${++next}`;
}

test("parse keeps duplicate headings as independent stable cards", () => {
  const sections = parseComposerSections("## Instructions\none\n## Instructions\ntwo", ids());
  assert.deepEqual(
    sections.map(({ id, title, level }) => ({ id, title, level })),
    [
      { id: "section-1", title: "Instructions", level: 2 },
      { id: "section-2", title: "Instructions", level: 2 },
    ],
  );
});

test("serialization canonicalizes only boundaries between cards", () => {
  const sections = parseComposerSections("intro\n# One\na\n# Two\nb\n", ids());
  assert.equal(serializeComposerSections(sections), "intro\n\n# One\na\n\n# Two\nb\n");
});

test("insert places one section at the exact middle index", () => {
  const current = parseComposerSections("# A\na\n\n# C\nc", ids());
  const result = insertComposerMarkdown(current, 1, "# B\nb", ids());
  assert.deepEqual(result.map((section) => section.title), ["A", "B", "C"]);
  assert.equal(serializeComposerSections(result), "# A\na\n\n# B\nb\n\n# C\nc");
});

test("whole prompt insert stays an ordered block at the drop index", () => {
  const current = parseComposerSections("# A\na\n\n# D\nd", ids());
  const result = insertComposerMarkdown(current, 1, "# B\nb\n## C\nc", ids());
  assert.deepEqual(result.map((section) => section.title), ["A", "B", "C", "D"]);
});

test("move reorders by stable id and clamps the target index", () => {
  const current = parseComposerSections("# A\na\n# B\nb\n# C\nc", ids());
  assert.deepEqual(moveComposerSection(current, current[0].id, 3).map((section) => section.title), ["B", "C", "A"]);
  assert.deepEqual(moveComposerSection(current, current[2].id, -4).map((section) => section.title), ["C", "A", "B"]);
});

test("editing a card creates another card only when a real heading is added", () => {
  const current = parseComposerSections("# A\na", ids());
  const result = updateComposerSection(current, current[0].id, "# A\na\n## B\nb", ids());
  assert.equal(result[0].id, current[0].id);
  assert.deepEqual(result.map((section) => section.title), ["A", "B"]);
});

test("heading-like fenced content does not create a new edited card", () => {
  const current = parseComposerSections("# A\na", ids());
  const result = updateComposerSection(current, current[0].id, "# A\n```md\n## not a card\n```", ids());
  assert.equal(result.length, 1);
});

test("remove deletes only the selected duplicate", () => {
  const current = parseComposerSections("# Same\none\n# Same\ntwo", ids());
  const result = removeComposerSection(current, current[0].id);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, "# Same\ntwo");
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/section-composer.test.ts
```

Expected: FAIL with `Cannot find module './section-composer.ts'`.

- [ ] **Step 3: Implement the minimal pure model**

Create `section-composer.ts`:

```ts
import { splitSections } from "./sections.ts";

export interface ComposerSection {
  id: string;
  title: string;
  level: number;
  body: string;
}

export type SectionIdFactory = () => string;

export function parseComposerSections(markdown: string, makeId: SectionIdFactory): ComposerSection[] {
  return splitSections(markdown).map(({ title, level, body }) => ({ id: makeId(), title, level, body }));
}

function canonicalBody(body: string, index: number, length: number): string {
  const withoutLeadingBoundary = index === 0 ? body : body.replace(/^\n+/, "");
  return index === length - 1 ? withoutLeadingBoundary : `${withoutLeadingBoundary.replace(/\n+$/, "")}\n\n`;
}

export function serializeComposerSections(sections: readonly ComposerSection[]): string {
  return sections.map((section, index) => canonicalBody(section.body, index, sections.length)).join("");
}

export function insertComposerMarkdown(
  sections: readonly ComposerSection[],
  index: number,
  markdown: string,
  makeId: SectionIdFactory,
): ComposerSection[] {
  if (markdown.length === 0) return [...sections];
  const inserted = parseComposerSections(markdown, makeId);
  const target = Math.max(0, Math.min(index, sections.length));
  return [...sections.slice(0, target), ...inserted, ...sections.slice(target)];
}

export function moveComposerSection(
  sections: readonly ComposerSection[],
  id: string,
  targetIndex: number,
): ComposerSection[] {
  const sourceIndex = sections.findIndex((section) => section.id === id);
  if (sourceIndex === -1) return [...sections];
  const next = [...sections];
  const [moved] = next.splice(sourceIndex, 1);
  const adjusted = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(Math.max(0, Math.min(adjusted, next.length)), 0, moved);
  return next;
}

export function updateComposerSection(
  sections: readonly ComposerSection[],
  id: string,
  markdown: string,
  makeId: SectionIdFactory,
): ComposerSection[] {
  const index = sections.findIndex((section) => section.id === id);
  if (index === -1) return [...sections];
  const parsed = parseComposerSections(markdown, makeId);
  parsed[0] = { ...parsed[0], id };
  return [...sections.slice(0, index), ...parsed, ...sections.slice(index + 1)];
}

export function removeComposerSection(sections: readonly ComposerSection[], id: string): ComposerSection[] {
  return sections.filter((section) => section.id !== id);
}
```

- [ ] **Step 4: Run the model and existing parser tests**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/section-composer.test.ts lib/prompt-library/sections.test.ts
```

Expected: all section-composer and section-parser tests PASS.

- [ ] **Step 5: Commit only the model and tests**

```bash
git add apps/dashboard/lib/prompt-library/section-composer.ts apps/dashboard/lib/prompt-library/section-composer.test.ts
git commit -m "feat(dashboard): add prompt section composer model"
```

---

### Task 2: Extract reusable Tiptap toolbar and card surface

**Files:**
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-toolbar.tsx`
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-editor-surface.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx`

**Interfaces:**
- Consumes: Tiptap `Editor`, `EditorContent`, `Markdown`, `StarterKit`, `VariableHighlight`, `VariablePickerPopover`, and the current editor's action behavior.
- Produces: `PromptToolbar({ editor, raw, onToggleRaw, disabled })` and `PromptEditorSurface({ value, onChange, onFocusEditor, disabled, className })`.

- [ ] **Step 1: Record the baseline before extraction**

Run:

```bash
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard test
```

Expected: both commands PASS before the refactor. If either fails because of pre-existing user changes, record the exact failure and do not broaden this task to fix unrelated code.

- [ ] **Step 2: Extract the toolbar with the existing button behavior**

Move `toolBtn`, `toolBtnActive`, `toolSep`, `Action`, and `useEditorActions` from `prompt-editor.tsx` into `prompt-toolbar.tsx`. Export this exact public component:

```tsx
export function PromptToolbar({
  editor,
  raw,
  onToggleRaw,
  disabled,
}: {
  editor: Editor | null;
  raw: boolean;
  onToggleRaw: () => void;
  disabled?: boolean;
}) {
  const actions = useEditorActions(raw ? null : editor);
  const [varOpen, setVarOpen] = useState(false);
  const varAnchorRef = useRef<HTMLButtonElement>(null);
  const insertVariable = (token: string) => editor?.chain().focus().insertContent(token).run();

  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-neutral-200 px-1.5 py-1">
      {!raw && actions.map((action) => (
        <ToolbarAction key={action.key} action={action} disabled={disabled || !editor} />
      ))}
      {!raw && (
        <button
          ref={varAnchorRef}
          type="button"
          title="Insert variable"
          disabled={disabled || !editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVarOpen((open) => !open)}
          className={`${toolBtn} ml-0.5 gap-1 px-2 text-mariner`}
        >
          <span className="text-[13px] leading-none">+</span> Variable
        </button>
      )}
      <button
        type="button"
        onClick={onToggleRaw}
        className={`${toolBtn} ml-auto uppercase tracking-[0.04em] ${raw ? toolBtnActive : ""}`}
        title="Toggle raw markdown"
      >
        Raw
      </button>
      <VariablePickerPopover
        open={varOpen}
        anchorRef={varAnchorRef}
        onPick={(token) => {
          insertVariable(token);
          setVarOpen(false);
        }}
        onClose={() => setVarOpen(false)}
      />
    </div>
  );
}
```

`ToolbarAction` must preserve the existing separators, `onMouseDown` focus protection, active styling, titles, and disabled behavior exactly.

```tsx
function ToolbarAction({ action, disabled }: { action: Action; disabled: boolean }) {
  return (
    <span className="flex items-center">
      {(action.key === "bold" || action.key === "bullet") && <span className={toolSep} aria-hidden="true" />}
      <button
        type="button"
        title={action.title}
        aria-pressed={action.active}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={action.run}
        className={`${toolBtn} ${action.active ? toolBtnActive : ""} ${action.key === "bold" ? "font-bold" : ""}`}
      >
        {action.label}
      </button>
    </span>
  );
}
```

- [ ] **Step 3: Extract the toolbar-free editor surface**

Move Tiptap setup, controlled-value synchronization, context-menu handling, and `EditorContent` into `prompt-editor-surface.tsx`. Export this interface and ensure the focus callback is invoked from the editor's own focus event:

```tsx
export interface PromptEditorSurfaceProps {
  value: string;
  onChange: (markdown: string) => void;
  onFocusEditor?: (editor: Editor) => void;
  onReadyEditor?: (editor: Editor | null) => void;
  disabled?: boolean;
  className?: string;
}

export function PromptEditorSurface({
  value,
  onChange,
  onFocusEditor,
  onReadyEditor,
  disabled,
  className,
}: PromptEditorSurfaceProps) {
  const settingRef = useRef(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const editor = useEditor({
    editable: !disabled,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), Markdown, VariableHighlight],
    content: value,
    contentType: "markdown",
    editorProps: { attributes: { class: "ck-prose min-h-[72px] focus:outline-none" } },
    onFocus: ({ editor }) => onFocusEditor?.(editor),
    onUpdate: ({ editor }) => {
      if (!settingRef.current) onChange(editor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor || value === editor.getMarkdown()) return;
    settingRef.current = true;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    settingRef.current = false;
  }, [editor, value]);

  useEffect(() => editor?.setEditable(!disabled), [disabled, editor]);
  useEffect(() => {
    onReadyEditor?.(editor);
    return () => onReadyEditor?.(null);
  }, [editor, onReadyEditor]);

  return (
    <div
      className={className}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
    >
      <EditorContent editor={editor} />
      <PromptEditorContextMenu editor={editor} at={menuAt} onClose={() => setMenuAt(null)} />
    </div>
  );
}
```

Rename the current `ContextMenu` to `PromptEditorContextMenu` and move it into the same file. Preserve its complete existing implementation, including action-page/variable-page state, portalling, position clamping, Escape/outside-pointer listeners, `onMouseDown` focus protection, and `editor.chain().focus().insertContent(token)` calls. The only signature change is that it receives `editor: Editor | null` and obtains its actions through the moved `useEditorActions(editor)` helper.

- [ ] **Step 4: Recompose the existing `PromptEditor`**

Keep `PromptEditorProps` unchanged. Replace its internal editor/toolbar duplication with one `PromptEditorSurface`, one `PromptToolbar`, and the current Raw textarea. Store the focused editor through `setActiveEditor`, retain `syncRequest` scroll behavior, and keep the same outer classes:

```tsx
const [activeEditor, setActiveEditor] = useState<Editor | null>(null);

<PromptToolbar
  editor={activeEditor}
  raw={raw}
  onToggleRaw={() => setRaw((current) => !current)}
  disabled={disabled}
/>
{raw ? (
  <textarea
    ref={rawScrollRef}
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    className={`w-full min-w-0 border-none bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] text-coal outline-none ${
      fill ? "min-h-0 flex-1 resize-none" : `resize-y ${minHeightClass ?? "min-h-[220px]"}`
    }`}
  />
) : (
  <div ref={editorScrollRef} className={`px-3 py-2.5 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
    <PromptEditorSurface
      value={value}
      onChange={onChange}
      onFocusEditor={setActiveEditor}
      disabled={disabled}
    />
  </div>
)}
```

Pass `onReadyEditor={setActiveEditor}` as well as `onFocusEditor={setActiveEditor}` so toolbar buttons are usable before the first click and cleanup clears the stale editor instance.

- [ ] **Step 5: Verify the extraction did not change behavior**

Run:

```bash
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard test
```

Expected: both commands PASS with no new warnings.

- [ ] **Step 6: Commit the extraction**

```bash
git add apps/dashboard/components/cockpit/prompt-editor/prompt-toolbar.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-editor-surface.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx
git commit -m "refactor(dashboard): extract prompt editor primitives"
```

---

### Task 3: Section composer state and accessible card UI

**Files:**
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer-context.tsx`
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx`
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`

**Interfaces:**
- Consumes: Task 1 model functions and Task 2 editor primitives.
- Produces: `PromptSectionComposerProvider`, `usePromptSectionComposer`, `PromptSectionComposer`, and the stable card state later consumed by drag sources.

- [ ] **Step 1: Add reducer-level tests for exact user actions**

Extend `section-composer.test.ts` with cases for moving up/down at boundaries, empty prompt insertion, and Raw reparsing:

```ts
test("empty prompt accepts a whole prompt at index zero", () => {
  const empty = parseComposerSections("", ids()).filter((section) => section.body.length > 0);
  const result = insertComposerMarkdown(empty, 0, "# Instructions\nDo it\n## Output\nJSON", ids());
  assert.deepEqual(result.map((section) => section.title), ["Instructions", "Output"]);
});

test("boundary moves are no-ops", () => {
  const current = parseComposerSections("# A\na\n# B\nb", ids());
  assert.deepEqual(moveComposerSectionByOffset(current, current[0].id, -1), current);
  assert.deepEqual(moveComposerSectionByOffset(current, current[1].id, 1), current);
});

test("offset moves match the accessible menu actions", () => {
  const current = parseComposerSections("# A\na\n# B\nb\n# C\nc", ids());
  assert.deepEqual(moveComposerSectionByOffset(current, current[1].id, -1).map((section) => section.title), ["B", "A", "C"]);
  assert.deepEqual(moveComposerSectionByOffset(current, current[1].id, 1).map((section) => section.title), ["A", "C", "B"]);
});

test("raw markdown becomes authoritative when reparsed", () => {
  const reparsed = parseComposerSections("intro\n### New\nvalue", ids());
  assert.deepEqual(reparsed.map((section) => [section.title, section.level]), [["Introduction", 0], ["New", 3]]);
});
```

- [ ] **Step 2: Run the tests and observe the boundary-move failure**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/section-composer.test.ts
```

Expected: FAIL because `moveComposerSectionByOffset` is not exported yet.

- [ ] **Step 3: Add the accessible-menu move helper**

Import `moveComposerSectionByOffset` in the test and add this export to `section-composer.ts`:

```ts
export function moveComposerSectionByOffset(
  sections: readonly ComposerSection[],
  id: string,
  offset: -1 | 1,
): ComposerSection[] {
  const sourceIndex = sections.findIndex((section) => section.id === id);
  if (sourceIndex === -1) return [...sections];
  const destination = sourceIndex + offset;
  if (destination < 0 || destination >= sections.length) return [...sections];
  return moveComposerSection(sections, id, offset > 0 ? destination + 1 : destination);
}
```

Run the focused test again. Expected: all section-composer tests PASS.

- [ ] **Step 4: Add the stable local provider**

In `prompt-section-composer-context.tsx`, define this public value and provider contract:

```tsx
interface PromptSectionComposerValue {
  sections: ComposerSection[];
  raw: boolean;
  rawValue: string;
  activeEditor: Editor | null;
  revealRequest: { id: number; target: "start" | "section"; sectionId?: string } | null;
  setActiveEditor: (editor: Editor | null) => void;
  setRawValue: (value: string) => void;
  toggleRaw: () => void;
  updateSection: (id: string, markdown: string) => void;
  removeSection: (id: string) => void;
  moveSection: (id: string, targetIndex: number) => void;
  insertMarkdown: (index: number, markdown: string) => void;
  replaceMarkdown: (markdown: string) => void;
  appendMarkdown: (markdown: string) => void;
}

const PromptSectionComposerContext = createContext<PromptSectionComposerValue | null>(null);

export function usePromptSectionComposer(): PromptSectionComposerValue {
  const value = useContext(PromptSectionComposerContext);
  if (!value) throw new Error("usePromptSectionComposer must be used inside PromptSectionComposerProvider");
  return value;
}

export function PromptSectionComposerProvider({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (markdown: string) => void;
  children: React.ReactNode;
}) {
  const nextId = useRef(0);
  const makeId = useCallback(() => `prompt-section-${++nextId.current}`, []);
  const [sections, setSections] = useState(() => parseComposerSections(value, makeId));
  const [raw, setRaw] = useState(false);
  const [rawValue, setRawDraft] = useState(value);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const revealId = useRef(0);
  const [revealRequest, setRevealRequest] = useState<PromptSectionComposerValue["revealRequest"]>(null);
  const serialized = useMemo(() => serializeComposerSections(sections), [sections]);

  const commit = useCallback((next: ComposerSection[]) => {
    setSections(next);
    onChange(serializeComposerSections(next));
  }, [onChange]);

  useEffect(() => {
    if (raw || value === serialized) return;
    setSections(parseComposerSections(value, makeId));
    setRawDraft(value);
  }, [makeId, raw, serialized, value]);

  const api = useMemo<PromptSectionComposerValue>(() => ({
    sections,
    raw,
    rawValue,
    activeEditor,
    revealRequest,
    setActiveEditor,
    setRawValue(next) {
      setRawDraft(next);
      onChange(next);
    },
    toggleRaw() {
      if (raw) {
        setSections(parseComposerSections(rawValue, makeId));
        setRaw(false);
      } else {
        setRawDraft(serialized);
        setRaw(true);
      }
    },
    updateSection(id, markdown) {
      commit(updateComposerSection(sections, id, markdown, makeId));
    },
    removeSection(id) {
      commit(removeComposerSection(sections, id));
    },
    moveSection(id, targetIndex) {
      commit(moveComposerSection(sections, id, targetIndex));
    },
    insertMarkdown(index, markdown) {
      const base = sections.length === 1 && sections[0].body === "" ? [] : sections;
      commit(insertComposerMarkdown(base, index, markdown, makeId));
    },
    replaceMarkdown(markdown) {
      commit(parseComposerSections(markdown, makeId));
      setRevealRequest({ id: ++revealId.current, target: "start" });
    },
    appendMarkdown(markdown) {
      const base = sections.length === 1 && sections[0].body === "" ? [] : sections;
      const next = insertComposerMarkdown(base, base.length, markdown, makeId);
      const firstInserted = next[base.length];
      commit(next);
      if (firstInserted) {
        setRevealRequest({ id: ++revealId.current, target: "section", sectionId: firstInserted.id });
      }
    },
  }), [activeEditor, commit, makeId, onChange, raw, rawValue, revealRequest, sections, serialized]);

  return <PromptSectionComposerContext.Provider value={api}>{children}</PromptSectionComposerContext.Provider>;
}
```

Use `useRef(0)` and `useCallback(() => `prompt-section-${++nextId.current}`, [])` for session-only IDs. Initialize local sections once from `value`. Every local mutation must call one `commit(nextSections)` function that sets the array and calls `onChange(serializeComposerSections(nextSections))`. An external `value` effect must return immediately when it equals `serializeComposerSections(sections)`; otherwise it reparses with new IDs. While Raw is active, `setRawValue` updates only the raw draft and parent markdown. `toggleRaw` reparses `rawValue` only when returning to Visual.

- [ ] **Step 5: Create the editable section card**

Implement `PromptSectionCard` with exact props:

```tsx
export function PromptSectionCard({
  section,
  index,
  count,
}: {
  section: ComposerSection;
  index: number;
  count: number;
}) {
  const { updateSection, removeSection, moveSection, setActiveEditor } = usePromptSectionComposer();
  return (
    <article className="group/section relative rounded-md border border-neutral-200 bg-panel shadow-[0_2px_8px_rgba(24,27,32,0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-mariner-200 focus-within:shadow-[0_4px_14px_rgba(31,90,166,0.10)]">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-2 py-1.5">
        <button
          type="button"
          aria-label={`Drag ${section.title}`}
          className="inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-[3px] text-neutral-400 hover:bg-off-white hover:text-mariner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner-200 active:cursor-grabbing"
        >
          ⠿
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold text-neutral-600">
          {section.level === 0 ? "Introduction" : `H${section.level} · ${section.title}`}
        </span>
        <SectionActions
          title={section.title}
          canMoveUp={index > 0}
          canMoveDown={index < count - 1}
          onMoveUp={() => moveSection(section.id, index - 1)}
          onMoveDown={() => moveSection(section.id, index + 2)}
          onRemove={() => removeSection(section.id)}
        />
      </div>
      <PromptEditorSurface
        value={section.body}
        onChange={(markdown) => updateSection(section.id, markdown)}
        onFocusEditor={setActiveEditor}
        className="px-3 py-2"
      />
    </article>
  );
}
```

Add this compact disclosure menu in the same file; use the project's existing enter/exit utility if animation is needed, but keep the behavior and labels unchanged:

```tsx
function SectionActions({
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  title: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button type="button" aria-label="Section actions" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex size-7 items-center justify-center rounded-[3px] text-neutral-500 hover:bg-off-white">•••</button>
      {open && (
        <div role="menu" className="absolute right-0 top-8 z-20 min-w-32 rounded-md border border-neutral-200 bg-panel py-1 shadow-lg">
          <button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => { onMoveUp(); setOpen(false); }} className={menuItemClass}>Move up</button>
          <button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => { onMoveDown(); setOpen(false); }} className={menuItemClass}>Move down</button>
          <button type="button" role="menuitem" onClick={() => { onRemove(); setOpen(false); }} className={`${menuItemClass} text-red-700`}>Remove section</button>
        </div>
      )}
    </div>
  );
}
```

Define `menuItemClass` as `"block w-full appearance-none px-3 py-1.5 text-left font-body text-[12px] text-neutral-700 hover:bg-off-white disabled:cursor-default disabled:opacity-40"`. Do not make the card itself draggable yet—the handle is wired in Task 4.

- [ ] **Step 6: Create the right-side Visual/Raw composer**

Implement `PromptSectionComposer` with a pinned `PromptToolbar`, one scroll owner, and an empty state:

```tsx
export function PromptSectionComposer() {
  const composer = usePromptSectionComposer();
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-[3px] border border-neutral-200 bg-panel">
      <PromptToolbar
        editor={composer.activeEditor}
        raw={composer.raw}
        onToggleRaw={composer.toggleRaw}
      />
      {composer.raw ? (
        <textarea
          value={composer.rawValue}
          onChange={(event) => composer.setRawValue(event.target.value)}
          aria-label="Raw prompt markdown"
          className="min-h-0 w-full min-w-0 flex-1 resize-none border-none bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] text-coal outline-none"
        />
      ) : (
        <div data-prompt-composer-scroll className="min-h-0 flex-1 overflow-y-auto bg-off-white p-3">
          {composer.sections.length === 0 || (composer.sections.length === 1 && composer.sections[0].body === "") ? (
            <div className="grid min-h-[220px] place-items-center rounded-md border border-dashed border-neutral-300 bg-panel px-6 text-center font-body text-[12px] text-neutral-500">
              Start writing in Raw mode or add a prompt from the library.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {composer.sections.map((section, index) => (
                <PromptSectionCard key={section.id} section={section} index={index} count={composer.sections.length} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Attach a ref to `[data-prompt-composer-scroll]`. In an effect keyed by `composer.revealRequest?.id`, set `scrollTop = 0` only for `target: "start"`; for `target: "section"`, find `[data-section-id="..."]` inside that scroll owner and call `scrollIntoView({ block: "nearest" })`. Add `data-section-id={section.id}` to each card shell. No ordinary `value` update triggers this effect.

- [ ] **Step 7: Run focused tests and type checking**

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/section-composer.test.ts
pnpm --filter ai-workflow-dashboard typecheck
```

Expected: all focused tests PASS and TypeScript reports no errors.

- [ ] **Step 8: Commit the non-drag composer**

```bash
git add apps/dashboard/lib/prompt-library/section-composer.ts apps/dashboard/lib/prompt-library/section-composer.test.ts apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer-context.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx
git commit -m "feat(dashboard): add accessible prompt section cards"
```

---

### Task 4: Sortable card drag and drop

**Files:**
- Modify: `apps/dashboard/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.ts`
- Create: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.test.ts`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer-context.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`

**Interfaces:**
- Consumes: `ComposerSection[]` and provider mutations from Task 3.
- Produces: modal-wide `DndContext`, `PromptDragPayload`, `resolvePromptDropIndex`, sortable card handles, exact insertion targets, compact overlay, and accessible announcements.

- [ ] **Step 1: Install pinned dnd-kit packages**

Run:

```bash
pnpm --filter ai-workflow-dashboard add @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2
```

Expected: only `apps/dashboard/package.json` and `pnpm-lock.yaml` change for dependency installation.

- [ ] **Step 2: Write failing drop-resolution tests**

Create `prompt-section-dnd.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePromptDropIndex } from "./prompt-section-dnd.ts";

const sections = [
  { id: "a", title: "A", level: 1, body: "# A" },
  { id: "b", title: "B", level: 1, body: "# B" },
  { id: "c", title: "C", level: 1, body: "# C" },
];

test("explicit insertion targets keep their exact index", () => {
  assert.equal(resolvePromptDropIndex(sections, { kind: "composer-insertion", index: 2 }, "before"), 2);
});

test("card targets resolve to before or after its index", () => {
  const target = { kind: "composer-section", sectionId: "b", label: "B" } as const;
  assert.equal(resolvePromptDropIndex(sections, target, "before"), 1);
  assert.equal(resolvePromptDropIndex(sections, target, "after"), 2);
});

test("unknown targets cancel instead of appending", () => {
  assert.equal(resolvePromptDropIndex(sections, { kind: "composer-section", sectionId: "missing", label: "Missing" }, "after"), null);
});
```

Run:

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test components/cockpit/prompt-editor/prompt-section-dnd.test.ts
```

Expected: FAIL with `Cannot find module './prompt-section-dnd.ts'`.

- [ ] **Step 3: Define the shared payloads and drop resolver**

Create `prompt-section-dnd.ts`:

```ts
import type { ComposerSection } from "@/lib/prompt-library/section-composer";

export type PromptDragPayload =
  | { kind: "composer-section"; sectionId: string; label: string }
  | { kind: "library-section"; markdown: string; label: string }
  | { kind: "library-prompt"; markdown: string; label: string; sectionCount: number };

export interface PromptDropTarget {
  kind: "composer-insertion";
  index: number;
}

export type PromptDropData = PromptDropTarget | Extract<PromptDragPayload, { kind: "composer-section" }>;
export type PromptDropEdge = "before" | "after";

export function resolvePromptDropIndex(
  sections: readonly ComposerSection[],
  over: PromptDropData,
  edge: PromptDropEdge,
): number | null {
  if (over.kind === "composer-insertion") return Math.max(0, Math.min(over.index, sections.length));
  const index = sections.findIndex((section) => section.id === over.sectionId);
  if (index === -1) return null;
  return edge === "after" ? index + 1 : index;
}
```

Run the focused test again. Expected: all three drop-resolution tests PASS.

- [ ] **Step 4: Configure provider-level sensors and drop handling**

Import the shared types into `prompt-section-composer-context.tsx`.

Configure sensors with an 8 px pointer activation distance and sortable keyboard coordinates:

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
);
```

Wrap provider children in `DndContext` using `closestCenter`, accessible screen-reader instructions, `onDragStart`, `onDragCancel`, and `onDragEnd`. `onDragEnd` reads `active.data.current` as `PromptDragPayload`. It accepts either an explicit `PromptDropTarget` or another composer card as `PromptDropData`. For pointer input, calculate `before`/`after` by comparing the translated active center with `over.rect.top + over.rect.height / 2`; keyboard input uses the target card's sortable index. Resolve the final index with `resolvePromptDropIndex`; composer sources call `moveSection`, and library sources call `insertMarkdown`. A null payload, null `over`, or null resolved index is a strict no-op.

- [ ] **Step 5: Wire sortable cards and insertion targets**

In `PromptSectionCard`, use `useSortable({ id: section.id, data: { kind: "composer-section", sectionId: section.id, label: section.title } satisfies PromptDragPayload })`. Apply transform only to the card shell, pass `attributes` and `listeners` only to the handle, and set `aria-describedby` through dnd-kit rather than inventing another hidden instruction.

In `PromptSectionComposer`, add a `PromptInsertionTarget` before every card and after the final card:

```tsx
function PromptInsertionTarget({ index }: { index: number }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `prompt-drop-${index}`,
    data: { kind: "composer-insertion", index } satisfies PromptDropTarget,
  });
  return (
    <div ref={setNodeRef} className="relative h-2" aria-hidden="true">
      <div className={`absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-mariner transition-opacity duration-100 ${isOver ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}
```

Use `SortableContext` with `verticalListSortingStrategy`, and render the insertion targets without adding document-like blank space. Empty mode renders one droppable target with index `0` and the text `Drop a prompt or section here`.

- [ ] **Step 6: Add a compact drag overlay and scroll behavior**

Render a `DragOverlay dropAnimation={null}>` from the provider's active payload. The overlay contains only the grip, label, and for whole prompts `N sections`; cap it at 280 px and use the existing panel border/shadow.

Leave dnd-kit's scroll handling enabled on the single `[data-prompt-composer-scroll]` owner. On drop, call `requestAnimationFrame` and `scrollIntoView({ block: "nearest" })` only for the inserted/moved card. Never assign `scrollTop = 0` for drag operations. Store the pre-drag scroll value and restore it in `onDragCancel`.

- [ ] **Step 7: Verify keyboard and pointer build contracts**

Run:

```bash
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard build
```

Expected: typecheck, all tests, and production build PASS.

- [ ] **Step 8: Commit sortable card support**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.ts apps/dashboard/components/cockpit/prompt-editor/prompt-section-dnd.test.ts apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer-context.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx
git commit -m "feat(dashboard): make prompt sections sortable"
```

---

### Task 5: Library drag sources and modal integration

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`

**Interfaces:**
- Consumes: `PromptDragPayload` from `prompt-section-dnd.ts`, plus `PromptSectionComposerProvider`, `usePromptSectionComposer`, and `PromptSectionComposer`.
- Produces: whole-prompt and individual-section drag sources connected to exact right-side targets while existing click actions remain intact.

- [ ] **Step 1: Add dedicated library drag handles**

Create a small local `LibraryDragHandle` in `prompt-library-rail.tsx`:

```tsx
function LibraryDragHandle({ id, payload }: { id: string; payload: PromptDragPayload }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: payload });
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label={`Drag ${payload.label}`}
      className={`inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-[3px] text-neutral-400 hover:bg-panel hover:text-mariner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner-200 active:cursor-grabbing ${isDragging ? "opacity-40" : "opacity-100"}`}
      {...attributes}
      {...listeners}
    >
      ⠿
    </button>
  );
}
```

Place a whole-prompt handle beside the selected prompt name with payload `{ kind: "library-prompt", markdown: activeBody, label: activeRow.name, sectionCount: sections.length }`. Place one section handle at the start of each preview card with payload `{ kind: "library-section", markdown: section.body, label: section.title }`. Listeners live only on dedicated handles, so the existing insert buttons remain ordinary clickable controls and do not start drags.

- [ ] **Step 2: Mount the provider around both modal panes**

In `prompt-editor-modal.tsx`, replace the right-side `PromptEditor` with `PromptSectionComposer`, and wrap the rail plus editor layout in one provider:

```tsx
<PromptSectionComposerProvider value={value} onChange={onChange}>
  <div className="flex min-h-0 min-w-0 flex-1">
    <div
      className={`min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-standard motion-reduce:transition-none ${
        libOpen ? "w-[40%] border-r border-neutral-200" : "w-0"
      }`}
    >
      <PromptLibraryPane onReplaceRef={onReplaceRef} targetHasContent={hasContent} />
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 p-4">
      <PromptSectionComposer />
    </div>
  </div>
</PromptSectionComposerProvider>
```

Keep the stable modal close callback, scroll lock, Escape ordering, 94 vw / 1240 px modal width, 90 vh height, and 40/60 panel relationship unchanged.

- [ ] **Step 3: Route existing button insertions through composer intent**

The modal must no longer rely on a later parent reparse for visible insert behavior. Inside the provider subtree, bridge existing payloads to composer methods:

```tsx
function PromptLibraryPane({
  onReplaceRef,
  targetHasContent,
}: {
  onReplaceRef: (ref: PromptSourceRef | null) => void;
  targetHasContent: boolean;
}) {
  const composer = usePromptSectionComposer();
  const handleInsert = (payload: PromptInsertPayload) => {
    if (payload.mode === "replace") {
      composer.replaceMarkdown(payload.text);
      onReplaceRef(payload.ref);
    } else {
      composer.appendMarkdown(payload.text);
    }
  };
  return <PromptLibraryRail onInsert={handleInsert} targetHasContent={targetHasContent} />;
}
```

Change `PromptEditorModal`'s current `onInsert` prop to `onReplaceRef: (ref: PromptSourceRef | null) => void`. The composer is the only code path that writes prompt text inside the modal. In `PromptField`, pass this exact callback:

```tsx
const handleExpandedReplaceRef = useCallback(
  (nextRef: PromptSourceRef | null) => onChange(`promptRefs.${paramKey}`, nextRef ?? undefined),
  [onChange, paramKey],
);

<PromptEditorModal
  open={expandOpen}
  onClose={closeExpandedEditor}
  value={value}
  onChange={setBodyValue}
  onReplaceRef={handleExpandedReplaceRef}
  blockName={node.name || node.type}
  fieldLabel={label}
/>
```

This preserves the existing provenance rule: `Replace all` adopts the selected library reference, while `Add to end`, section insertion, reordering, and drag composition leave the existing reference in place so drift becomes `edited`. Confirm `Replace all` starts at the top and `Add to end` reveals the first appended card; exact-position drag reveals only its drop location.

- [ ] **Step 4: Add precise focus and scroll regression checks to the manual checklist**

In the running dashboard:

1. Type at least five characters in the middle card; the caret stays in that card and no page button gains focus.
2. Drag one library section before the middle card; the composer remains near that location.
3. Drag a whole prompt between two cards; all source sections appear consecutively there.
4. Reorder duplicate-titled cards; only the grabbed instance moves.
5. Start a drag and press Escape; markdown, focus, and scroll remain unchanged.
6. Use `Move up` and `Move down` from the keyboard-only actions menu.
7. Switch to Raw, add an H2, switch back, and confirm a new card appears.
8. Return to Raw and confirm card order matches the markdown order.

- [ ] **Step 5: Run full dashboard verification**

Run:

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
git diff --check
```

Expected: the dashboard test suite, typecheck, and production build PASS; `git diff --check` prints nothing.

- [ ] **Step 6: Commit the end-to-end integration**

```bash
git add apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx
git commit -m "feat(dashboard): drag library prompts into section composer"
```

---

### Task 6: UX polish and final regression pass

**Files:**
- Modify only if verification exposes a scoped issue: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx`
- Modify only if verification exposes a scoped issue: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`
- Modify only if verification exposes a scoped issue: `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`
- Modify only if verification exposes a scoped issue: `apps/dashboard/app/globals.css`

**Interfaces:**
- Consumes: completed section composer.
- Produces: verified responsive, accessible, reduced-motion behavior with no unrelated styling changes.

- [ ] **Step 1: Inspect the full interaction at representative widths**

Verify at approximately 1440 px, 1100 px, and 800 px viewport widths. Confirm the rail and composer can shrink (`min-w-0`), long headings truncate instead of widening the modal, one pane owns each vertical scroll, and card gaps read as grouping rather than blank markdown lines.

- [ ] **Step 2: Verify focus, keyboard, and reduced motion**

Tab to every library and composer handle. Use Space/Enter plus arrow keys to move and drop, Escape to cancel, and the actions menu as the explicit keyboard fallback. Enable `prefers-reduced-motion: reduce` and confirm card/overlay transitions do not animate transforms.

- [ ] **Step 3: Make only evidence-driven polish corrections**

If a check fails, change only the responsible component. Use these exact visual constraints:

```text
Card gap: 8 px
Drop target hit area: at least 8 px high; visible line: 2 px
Drag handle: 28 × 28 px minimum
Card focus: mariner-200 border plus subtle mariner shadow
Drag overlay: maximum width 280 px
Motion: 100–150 ms; motion-reduce disables transforms/transitions
```

Do not refactor adjacent global typography or modal components during polish.

- [ ] **Step 4: Run final automated verification**

Run:

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
git diff --check
git status --short
```

Expected: tests, typecheck, and build PASS; diff check is silent; status contains only intentional task files plus the user's known pre-existing changes.

- [ ] **Step 5: Commit polish only when files changed**

If Task 6 required code changes:

```bash
git add apps/dashboard/components/cockpit/prompt-editor/prompt-section-card.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/app/globals.css
git commit -m "fix(dashboard): polish prompt section drag interactions"
```

If no Task 6 files changed, do not create an empty commit.
