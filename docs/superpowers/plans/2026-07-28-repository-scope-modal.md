# Repository Scope Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expanding provider/repository controls with one compact source-scope summary row and a draft-based modal that never shifts the workflow editor.

**Architecture:** `RepositoryScopeBar` becomes a compact read-only summary plus the modal trigger. A new `RepositoryScopeModal` owns a local `WorkflowRepositoryScope` draft, catalog selection UI, warnings, and apply/cancel behavior; existing helpers in `repository-scope.ts` remain the only mutation and description logic.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, `react-test-renderer`, Node test runner

## Global Constraints

- Do not change repository scope contracts, validation, catalog loading, or workflow serialization.
- The collapsed control is one row and opening the modal must not change document layout.
- Provider and repository summary badges use one shared height, radius, padding, and vertical alignment.
- Modal changes stay local until `Apply scope`; every cancel path discards them.
- Preserve the eight-repository limit, catalog refresh behavior, exact-path fallback, and all existing warnings.
- Do not add a modal, focus-management, or animation dependency.
- Interactive targets are at least 40 by 40 pixels and all controls retain visible keyboard focus.

---

### Task 1: Compact source-scope summary and modal draft boundary

**Files:**
- Create: `apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx`

**Interfaces:**
- Consumes: `WorkflowRepositoryScope`, `VcsProviderKind`, and the existing helpers exported by `apps/dashboard/lib/workflow-editor/repository-scope.ts`.
- Produces:

```ts
export interface RepositoryScopeModalProps {
  open: boolean;
  scope: WorkflowRepositoryScope;
  canEdit: boolean;
  onApply: (scope: WorkflowRepositoryScope) => void;
  onCancel: () => void;
}

export function RepositoryScopeModal(
  props: RepositoryScopeModalProps,
): React.ReactNode;
```

- [ ] **Step 1: Replace static bar expectations with compact-summary and dialog expectations**

Update `repository-scope-bar.test.tsx` so the empty scope asserts:

```ts
const html = renderBar({});
assert.match(html, /Source scope/);
assert.match(html, /Automatic provider/);
assert.match(html, /Automatic per ticket/);
assert.match(html, /Configure/);
assert.doesNotMatch(html, /Add repositories/);
```

Add a direct modal render helper and assertions for `role="dialog"`,
`aria-modal="true"`, `Configure source scope`, `Providers`, `Repositories`,
`Cancel`, and `Apply scope`. Keep the existing catalog-state, warning, and
read-only assertions, moving modal-only assertions to the modal helper.

- [ ] **Step 2: Add failing behavior tests for the draft boundary**

Replace bar helpers that directly toggle providers or remove chips with modal
actions. Add tests that mount a controlled bar and prove:

```ts
await bar.openModal();
await bar.toggleProvider("GitHub");
await bar.cancel();
assert.deepEqual(bar.changes, []);

await bar.openModal();
await bar.toggleProvider("GitHub");
await bar.apply();
assert.deepEqual(bar.changes, [{ providers: ["github"] }]);
```

Also assert that the configure button has `aria-haspopup="dialog"`, the modal
exists only while open, and a disabled read-only configure button cannot open
it.

- [ ] **Step 3: Run the focused tests and verify the new expectations fail**

Run:

```bash
pnpm --dir apps/dashboard exec tsx --test \
  components/cockpit/flow-editor/repository-scope-bar.test.tsx \
  components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
```

Expected: failures because the bar still renders two rows and no
`RepositoryScopeModal` exists.

- [ ] **Step 4: Implement the modal shell with an isolated draft**

Create `repository-scope-modal.tsx` with:

```tsx
export function RepositoryScopeModal({
  open,
  scope,
  canEdit,
  onApply,
  onCancel,
}: RepositoryScopeModalProps) {
  const titleId = useId();
  const [draft, setDraft] = useState<WorkflowRepositoryScope>(() =>
    structuredClone(scope),
  );

  useEffect(() => {
    if (open) setDraft(structuredClone(scope));
  }, [open, scope]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-coal/30 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(760px,calc(100dvh-32px))] w-full max-w-[680px] flex-col overflow-hidden rounded-[6px] bg-panel shadow-2xl"
      >
        <h2 id={titleId}>Configure source scope</h2>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section aria-labelledby={`${titleId}-providers`} />
          <section aria-labelledby={`${titleId}-repositories`} />
        </div>
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => onApply(draft)}
          >
            Apply scope
          </button>
        </footer>
      </section>
    </div>
  );
}
```

Wire `Escape` to `onCancel` on the dialog layer. Keep `draft` and `setDraft`
inside this component so no mutation reaches the editor before Apply.

- [ ] **Step 5: Replace the two bar rows with one compact summary row**

In `repository-scope-bar.tsx`, remove the inline picker and direct editing
controls. Render one row with:

```tsx
<div className="flex min-h-[52px] items-center gap-3 border-b border-neutral-200 bg-app-bg px-6 py-2">
  <div className="min-w-[110px]">
    <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-neutral-700">
      Source scope
    </div>
    <div className="font-body text-[10px] text-neutral-500">
      Providers & repositories
    </div>
  </div>
  <div className="flex min-w-0 flex-1 items-center gap-2">
    {/* equal-height provider badges and repository summary */}
  </div>
  <button
    type="button"
    aria-haspopup="dialog"
    disabled={!canEdit}
    onClick={() => setModalOpen(true)}
  >
    Configure
  </button>
</div>
```

Use a shared `scopeBadgeClass` containing `inline-flex h-6 items-center
rounded-[3px] border px-2`. Use `tabular-nums` on the repository count. Show
`Needs attention` with `role="status"` when the existing mismatch, archived, or
unknown calculations find a problem. Render `RepositoryScopeModal` as a sibling
of the row so the fixed overlay never changes row height.

- [ ] **Step 6: Run focused tests**

Run the focused command from Step 3.

Expected: all static summary, dialog shell, cancel, apply, and read-only tests
pass. Run only the draft-boundary behavior tests by their exact test-name
patterns at this checkpoint; the catalog behavior file is completed in Task 2.

- [ ] **Step 7: Commit the compact bar and modal boundary**

```bash
git add \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.test.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
git commit -m "feat(dashboard): move source scope into modal"
```

---

### Task 2: Repository catalog editing and warnings inside the modal

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.test.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx`

**Interfaces:**
- Consumes: `RepositoryScopeModalProps` from Task 1, `useRepositoryCatalog()`,
  `addPinnedRepositories()`, `removePinnedRepository()`,
  `togglePinnedProvider()`, `contradictingPinnedRepositories()`,
  `MAX_PINNED_REPOSITORIES`, and `PINNABLE_PROVIDERS`.
- Produces: a complete draft editor that calls `onApply(draft)` once and never
  calls it from intermediate controls.

- [ ] **Step 1: Write failing catalog draft tests**

Update the behavior harness to interact with modal controls and add assertions
for this sequence:

```ts
await modal.toggleRepository("Blazity/ai-workflow-prod", true);
await modal.setFilter("billing");
await modal.toggleRepository("acme-group/platform/billing-core", true);
await modal.apply();

assert.deepEqual(changes, [{
  repositories: [
    { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
    { provider: "gitlab", repoPath: "acme-group/platform/billing-core" },
  ],
}]);
```

Retain focused tests for filter persistence, the eight-repository limit,
refresh removing retired selections, archived rows, already-selected rows,
empty catalogs, catalog errors, and exact manual entry. Rewrite them to assert
draft checkbox/chip state before Apply and one parent change after Apply.

- [ ] **Step 2: Run the behavior tests and verify catalog cases fail**

Run:

```bash
pnpm --dir apps/dashboard exec tsx --test \
  components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
```

Expected: failures because the modal shell does not yet render provider,
catalog, selected-repository, or manual-entry controls.

- [ ] **Step 3: Implement provider controls and selected repository chips**

Inside the modal, render two equal-height provider toggles:

```tsx
{PINNABLE_PROVIDERS.map((provider) => {
  const active = (draft.providers ?? []).includes(provider);
  return (
    <button
      key={provider}
      type="button"
      aria-pressed={active}
      onClick={() => setDraft((current) =>
        togglePinnedProvider(current, provider)
      )}
      className="inline-flex h-10 min-w-[112px] items-center justify-center rounded-[4px] border px-3"
    >
      {providerLabel(provider)}
    </button>
  );
})}
```

Render selected repositories as consistent chips with a 40-pixel remove
button. Removal calls:

```ts
setDraft((current) => removePinnedRepository(current, repository));
```

- [ ] **Step 4: Implement direct catalog selection in the draft**

Reuse the current filter, `catalogByKey`, empty/loading/error distinctions, and
refresh action. Repository checkboxes reflect `isRepositoryPinned(draft,
option)`. Checking adds one entry with `addPinnedRepositories`; unchecking
removes it with `removePinnedRepository`.

Disable an unchecked row when it is archived or the draft already contains
`MAX_PINNED_REPOSITORIES`. Do not keep a second pending-selection array: the
modal draft already provides cancel/apply semantics and remains stable across
filter changes.

- [ ] **Step 5: Preserve manual fallback and contextual warnings**

For an empty or failed catalog, keep the existing provider listbox and exact
`owner/repo` input. `Add to selection` updates only `draft`. Preserve messages
for duplicates and the repository limit.

Render the current detailed messages inside the modal for:

```ts
contradictingPinnedRepositories(draft)
unknown pinned repositories after a settled catalog
archived pinned repositories
catalog loading and failure states
```

Keep the compact bar warning generic; detailed repository names and remediation
stay inside the modal.

- [ ] **Step 6: Run both focused test files**

Run:

```bash
pnpm --dir apps/dashboard exec tsx --test \
  components/cockpit/flow-editor/repository-scope-bar.test.tsx \
  components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
```

Expected: all repository scope tests pass.

- [ ] **Step 7: Commit catalog editing**

```bash
git add \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.test.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
git commit -m "feat(dashboard): edit repository scope as modal draft"
```

---

### Task 3: Keyboard containment, responsive polish, and full verification

**Files:**
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx`

**Interfaces:**
- Consumes: the complete `RepositoryScopeModal` from Task 2.
- Produces: focus containment, focus restoration, backdrop/Escape cancellation,
  internal viewport scrolling, and final visual consistency.

- [ ] **Step 1: Write failing dismissal and focus tests**

Add behavior tests that:

```ts
await modal.pressEscape();
assert.deepEqual(changes, []);
assert.equal(modal.isOpen(), false);

await modal.open();
await modal.clickBackdrop();
assert.deepEqual(changes, []);
assert.equal(modal.isOpen(), false);
```

Assert the dialog keydown handler wraps Tab from the last focusable control to
the first and Shift+Tab from the first to the last using a mocked
`currentTarget.querySelectorAll()` result. Verify focus restoration to
`Configure` during the browser smoke test in Step 5 because the current
`react-test-renderer` harness has no browser `document.activeElement`.

- [ ] **Step 2: Run the behavior test and verify dismissal/focus cases fail**

Run:

```bash
pnpm --dir apps/dashboard exec tsx --test \
  components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
```

Expected: new focus containment or dismissal assertions fail.

- [ ] **Step 3: Implement focus entry, containment, and restoration**

Use refs for the trigger and dialog. When the modal opens, focus the first
enabled provider toggle. On dialog `keydown`:

```ts
if (event.key === "Escape") onCancel();
if (event.key === "Tab") {
  const focusable = dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  // Wrap forward from the last item and backward from the first item.
}
```

When the modal closes, focus the trigger ref. Use exact transition properties
only; do not add `transition-all`. Respect `motion-reduce` if an opacity
transition is used.

- [ ] **Step 4: Finish responsive and interaction polish**

Use an internal `overflow-y-auto` body and sticky footer. Keep modal outer
spacing at `p-4`, width at `max-w-[680px]`, and height at
`max-h-[calc(100dvh-32px)]`. Give icon-only close/remove controls a 40 by 40
pixel hit area, add `focus-visible` rings, and use `active:scale-[0.96]` only on
standalone buttons where it does not move adjacent content.

- [ ] **Step 5: Run focused tests and inspect the workflow editor in a browser**

Run:

```bash
pnpm --dir apps/dashboard exec tsx --test \
  components/cockpit/flow-editor/repository-scope-bar.test.tsx \
  components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
```

Start the dashboard with its normal local environment and verify:

- opening and closing the modal does not move the canvas;
- the one-row summary remains aligned at desktop and narrow widths;
- Escape, backdrop, Cancel, close, and Apply behave as specified;
- keyboard focus stays in the dialog and returns to Configure;
- long repository lists scroll inside the modal;
- badges have equal height and do not visually jump between states.

- [ ] **Step 6: Run dashboard type checking and the full dashboard suite**

Run:

```bash
pnpm --dir apps/dashboard typecheck
pnpm --dir apps/dashboard test
```

Expected: both commands exit with status 0.

- [ ] **Step 7: Review the diff for scope and formatting**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~2
```

Confirm every changed source or test line belongs to the repository-scope modal
and no generated `.superpowers/` files are tracked.

- [ ] **Step 8: Commit final accessibility and polish**

```bash
git add \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-modal.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx \
  apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.behavior.test.tsx
git commit -m "fix(dashboard): polish source scope modal interactions"
```
