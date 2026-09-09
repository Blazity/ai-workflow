# Prompt Reference Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw prompt text in the workflow inspector with a structural summary and make every live prompt reference previewable in the modal rail and openable in the Prompts page.

**Architecture:** Extend the existing pure inspector summary model with composer-derived section metadata. Introduce a serializable `PromptPreviewRequest` passed from reference actions through the composer and modal into the library rail; it changes only rail selection state. Add a small query-selection helper so `/prompts?prompt=<id>` initializes the full Prompts screen deterministically.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, Node test runner through `tsx --test`.

## Global Constraints

- The workflow inspector must never render raw prompt Markdown or raw `{{prompt:id}}` tokens.
- The entire summary card must use `cursor-pointer`, visible hover/focus treatment, a chevron, and native button semantics.
- Inspector summaries show section count, live-reference count, character count, up to three section names, and `+N more` when needed.
- `Preview` is navigation only and must never call the workflow `onChange` callback.
- Read-only mode keeps `Preview` and `Open in library` available while hiding all mutation actions.
- `Open in library ↗` uses `/prompts?prompt=<id>` in a new tab.
- Missing references expose neither Preview nor library navigation.
- Do not add dependencies or change worker/runtime prompt-resolution behavior.
- Preserve unrelated dirty changes in `apps/dashboard/package.json` and `pnpm-lock.yaml`.

---

### Task 1: Structural Inspector Summary

**Files:**
- Modify: `apps/dashboard/lib/prompt-library/prompt-inspector-summary.ts`
- Modify: `apps/dashboard/lib/prompt-library/prompt-inspector-summary.test.ts`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.test.tsx`

**Interfaces:**
- Consumes: `parseComposerBlocks(markdown, makeId)` from `apps/dashboard/lib/prompt-library/composer.ts`.
- Produces: `PromptInspectorSummary` with `sectionTitles: string[]` and `remainingSectionCount: number` for custom prompts.

- [ ] **Step 1: Add failing structural-summary tests**

Add cases to `prompt-inspector-summary.test.ts`:

```ts
test("summarizes custom prompt structure without exposing raw markdown", () => {
  const value = "{{prompt:7}}\n\n## New section\nDraft\n\n## Output Format\nJSON";
  assert.deepEqual(promptInspectorSummary(value, value, undefined, [row(7, "research-plan", 2)]), {
    kind: "custom",
    title: "Custom prompt",
    detail: `${value.length} chars · ~${Math.ceil(value.length / 4)} tokens · 3 sections · 1 live prompt`,
    sectionTitles: ["research-plan", "New section", "Output Format"],
    remainingSectionCount: 0,
  });
});

test("caps section names and reports the remainder", () => {
  const value = "# One\na\n# Two\nb\n# Three\nc\n# Four\nd";
  const summary = promptInspectorSummary(value, value, undefined, []);
  assert.deepEqual(summary.sectionTitles, ["One", "Two", "Three"]);
  assert.equal(summary.remainingSectionCount, 1);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/prompt-inspector-summary.test.ts`

Expected: FAIL because structural fields are absent and custom summaries still include `preview`.

- [ ] **Step 3: Implement structural summary derivation**

Use the existing composer parser so summary block boundaries match the modal:

```ts
function promptStructure(value: string, rows: readonly PromptLibraryListRowDto[]) {
  let id = 0;
  const blocks = parseComposerBlocks(value, () => `summary-${++id}`);
  const titles = blocks.map((block) => {
    if (block.kind !== "reference") return block.title;
    const reference = parsePromptReferenceTokens(block.body)[0];
    return rows.find((row) => row.id === reference?.promptId)?.name
      ?? (reference ? `Missing prompt ${reference.promptId}` : block.title);
  });
  return {
    blockCount: blocks.length,
    referenceCount: blocks.filter((block) => block.kind === "reference").length,
    sectionTitles: titles.slice(0, 3),
    remainingSectionCount: Math.max(0, titles.length - 3),
  };
}
```

For `kind: "custom"`, remove the raw `preview` field and build `detail` from chars, tokens, section count, and live-reference count.

- [ ] **Step 4: Add failing card-markup tests**

Update `prompt-inspector-card.test.tsx` to assert:

```tsx
assert.match(html, /cursor-pointer/);
assert.match(html, /aria-hidden="true">→/);
assert.match(html, /research-plan/);
assert.match(html, /New section/);
assert.match(html, /Output Format/);
assert.doesNotMatch(html, /\{\{prompt:7\}\}|Return a JSON object/);
```

Expected: FAIL because the current card renders the old preview and has no explicit chevron/pointer class.

- [ ] **Step 5: Render the compact structural card**

In `PromptInspectorCard`:

- add `cursor-pointer`, `focus-visible:ring-2`, stronger `hover:border-mariner-200` and hover background;
- replace body preview with small section-name chips and `+N more`;
- render a trailing `→` with `aria-hidden="true"`;
- retain `Edit prompt` / `View prompt` copy and native `<button>` semantics.

- [ ] **Step 6: Verify Task 1**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/prompt-inspector-summary.test.ts components/cockpit/flow-editor/prompt-inspector-card.test.tsx && pnpm --filter ai-workflow-dashboard typecheck`

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/dashboard/lib/prompt-library/prompt-inspector-summary.ts apps/dashboard/lib/prompt-library/prompt-inspector-summary.test.ts apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.tsx apps/dashboard/components/cockpit/flow-editor/prompt-inspector-card.test.tsx
git commit -m "feat(dashboard): summarize prompt structure"
```

### Task 2: Reference Preview and Modal Rail Synchronization

**Files:**
- Create: `apps/dashboard/lib/prompt-library/reference-navigation.ts`
- Create: `apps/dashboard/lib/prompt-library/reference-navigation.test.ts`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`

**Interfaces:**
- Produces: `PromptPreviewRequest = { requestId: number; promptId: number; version: "latest" | number }`.
- `PromptReferenceChips` adds `onPreview?: (request: Omit<PromptPreviewRequest, "requestId">) => void` and `compact?: boolean`.
- `PromptSectionComposer` forwards `onPreviewReference` without calling `onChange`.
- `PromptEditorModal` owns the monotonic `requestId`, opens the rail, and passes `previewRequest` to `PromptLibraryRail`.

- [ ] **Step 1: Write failing reference-navigation state tests**

Create `reference-navigation.test.ts`:

```ts
test("latest selects the prompt current version", () => {
  assert.deepEqual(resolvePreviewSelection(
    { requestId: 1, promptId: 7, version: "latest" },
    [{ id: 7, currentVersion: 3 }],
    [1, 2, 3],
  ), { activeId: 7, selectedVersion: 3, missingVersion: false });
});

test("pinned selection and missing versions remain explicit", () => {
  assert.deepEqual(resolvePreviewSelection(
    { requestId: 2, promptId: 7, version: 2 },
    [{ id: 7, currentVersion: 3 }],
    [1, 2, 3],
  ), { activeId: 7, selectedVersion: 2, missingVersion: false });
  assert.deepEqual(resolvePreviewSelection(
    { requestId: 3, promptId: 7, version: 9 },
    [{ id: 7, currentVersion: 3 }],
    [1, 2, 3],
  ), { activeId: 7, selectedVersion: 9, missingVersion: true });
});

test("missing prompt cannot navigate", () => {
  assert.equal(resolvePreviewSelection(
    { requestId: 4, promptId: 99, version: "latest" },
    [{ id: 7, currentVersion: 3 }],
    [1, 2, 3],
  ), null);
});
```

- [ ] **Step 2: Verify RED and implement the pure state helper**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/reference-navigation.test.ts`

Expected: FAIL because the module does not exist.

Implement the exported type and `resolvePreviewSelection(...)` exactly as exercised above, then rerun until GREEN.

- [ ] **Step 3: Add compact reference navigation actions**

In `PromptReferenceChips`, render for each resolved reference:

```tsx
<button type="button" onClick={() => onPreview?.({ promptId: reference.promptId, version: reference.version })}>
  Preview
</button>
<Link
  href={`/prompts?prompt=${reference.promptId}`}
  target="_blank"
  rel="noreferrer"
  aria-label={`Open ${row.name} in prompt library (new tab)`}
>
  Open in library ↗
</Link>
```

Move `Pin` / `Follow latest` / `Detach` into one native-button overflow menu. Keep the mutation menu hidden when `disabled`; Preview and link remain visible. Missing prompt cards render neither navigation action.

- [ ] **Step 4: Wire Preview through the modal without mutation**

- `PromptSectionComposer` passes preview requests upward from reference blocks.
- `PromptEditorModal` increments `previewRequestId`, sets `libOpen(true)`, and stores the request.
- `PromptField` can open the modal with an initial request when Preview is clicked from its linked-prompt row.
- None of these handlers call `onChange`, `onInsert`, `setBodyValue`, Pin, or Detach.

- [ ] **Step 5: Synchronize the library rail**

In `PromptLibraryRail`:

- accept `previewRequest?: PromptPreviewRequest | null`;
- select `activeId` immediately when the referenced row exists;
- after detail loads, select pinned/current version through `resolvePreviewSelection`;
- retain a requested missing pinned version and show `Version vN unavailable` instead of silently switching versions;
- scroll the preview pane ref to `{ top: 0 }` for every new request id;
- do not fire `onInsert` during synchronization.

- [ ] **Step 6: Add permanent component/contract coverage**

Extend the current SSR/contract tests to assert:

- Preview and `/prompts?prompt=7` are present for resolved references;
- mutation actions are absent when disabled;
- Preview remains present when disabled;
- missing references have no navigation URL;
- preview handlers do not include an `onChange` capability.

- [ ] **Step 7: Verify Task 2**

Run: `pnpm --filter ai-workflow-dashboard test && pnpm --filter ai-workflow-dashboard typecheck`

Expected: dashboard tests and typecheck pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add apps/dashboard/lib/prompt-library/reference-navigation.ts apps/dashboard/lib/prompt-library/reference-navigation.test.ts apps/dashboard/components/cockpit/prompt-editor/prompt-reference-chips.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx apps/dashboard/components/cockpit/flow-editor/prompt-library-rail.tsx apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx
git commit -m "feat(dashboard): preview live prompt references"
```

### Task 3: Prompt Library Deep Link

**Files:**
- Create: `apps/dashboard/lib/prompt-library/query-selection.ts`
- Create: `apps/dashboard/lib/prompt-library/query-selection.test.ts`
- Modify: `apps/dashboard/components/cockpit/screens/prompt-library.tsx`

**Interfaces:**
- Produces: `initialPromptSelection(queryValue: string | null, rows: readonly PromptLibraryListRowDto[]): number | null`.
- Consumes: `useSearchParams().get("prompt")` in `PromptLibraryScreen`.

- [ ] **Step 1: Write failing query-selection tests**

```ts
test("selects an active prompt from a valid query", () => {
  assert.equal(initialPromptSelection("7", [row({ id: 7 }), row({ id: 8 })]), 7);
});

test("falls back for invalid, missing, and archived ids", () => {
  const rows = [row({ id: 7 }), row({ id: 8, archivedAt: "2026-07-01T00:00:00Z" })];
  assert.equal(initialPromptSelection(null, rows), 7);
  assert.equal(initialPromptSelection("nope", rows), 7);
  assert.equal(initialPromptSelection("99", rows), 7);
  assert.equal(initialPromptSelection("8", rows), 7);
});
```

- [ ] **Step 2: Verify RED and implement selection helper**

Run: `pnpm --filter ai-workflow-dashboard exec tsx --test lib/prompt-library/query-selection.test.ts`

Expected: FAIL because the helper module does not exist.

Implement strict positive-integer parsing, active-row lookup, and fallback to the first non-archived row; rerun until GREEN.

- [ ] **Step 3: Initialize the Prompts screen from the query**

```tsx
const searchParams = useSearchParams();
const requestedPrompt = searchParams.get("prompt");
const [activeId, setActiveId] = useState<number | null>(() =>
  initialPromptSelection(requestedPrompt, data.prompts),
);
```

On client-side query changes, update the active selection only when `initialPromptSelection` resolves the requested id itself; do not discard an in-progress dirty edit or reset normal user selection during live RSC refresh.

- [ ] **Step 4: Verify Task 3 and the full feature**

Run: `pnpm --filter ai-workflow-dashboard test`

Expected: all dashboard tests pass.

Run: `pnpm --filter ai-workflow-dashboard typecheck`

Expected: TypeScript exits with code 0.

Run: `pnpm --filter ai-workflow-dashboard build`

Expected: Next.js production build exits with code 0.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Manual browser verification**

Verify on planning, generic-agent, and call-LLM prompt fields:

- summary card pointer/hover/focus and no raw Markdown;
- section metadata and `+N more`;
- modal Preview selects the correct prompt/version and scrolls rail preview to top;
- overflow mutation menu behavior in editable and read-only workflows;
- library deep link opens the correct prompt in a new tab;
- missing prompt and missing-version states do not mutate the workflow.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/dashboard/lib/prompt-library/query-selection.ts apps/dashboard/lib/prompt-library/query-selection.test.ts apps/dashboard/components/cockpit/screens/prompt-library.tsx
git commit -m "feat(dashboard): deep link prompt library entries"
```

### Task 4: Final Review

**Files:**
- Review all Task 1–3 files without unrelated refactoring.

- [ ] **Step 1: Review against the approved design**

Confirm every design bullet maps to code or a permanent test and no Preview/navigation handler writes workflow state.

- [ ] **Step 2: Verify clean scoped history**

Run: `git log -6 --oneline && git status --short && git diff --check`

Expected: three feature commits after the design/plan commits; only the two preserved unrelated dirty files remain.

- [ ] **Step 3: Re-run verification after any review fix**

Run: `pnpm --filter ai-workflow-dashboard test && pnpm --filter ai-workflow-dashboard typecheck && pnpm --filter ai-workflow-dashboard build`

Expected: tests, typecheck, and build pass.
