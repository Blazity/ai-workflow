# Default Live Prompt UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-party agent defaults visible and executable as live `Latest` prompt-library references, open the library by default, and let users create an editable visual section without Raw mode.

**Architecture:** A shared agent-type-to-prompt-name mapping keeps the worker and dashboard aligned. The worker materializes omitted first-party prompts as reference tokens immediately before the existing recursive run-start resolver, while the dashboard derives the same effective token for display without persisting it until the user edits. The composer gains a small pure append helper and an autofocus path for newly created section cards.

**Tech Stack:** TypeScript, React 19, Next.js 15, Tiptap 3, Vitest, Node test runner, Drizzle ORM, Neon Postgres.

## Global Constraints

- Work directly in the current checkout; do not create a git worktree.
- Preserve existing unrelated and uncommitted dashboard changes.
- Existing workflow-definition versions with absent prompt params remain byte-compatible.
- An implicit default follows `Latest`; a run freezes and records the resolved version in `prompt_manifest`.
- Global ticket-variable substitution remains after recursive prompt-reference expansion.
- Do not add a fallback query for a missing database column.
- Do not change generic-agent or arbitrary prompt-field defaults.

---

### Task 1: Apply and verify the prompt manifest migration

**Files:**
- Existing migration: `apps/worker/drizzle/0021_flippant_justice.sql`
- Existing runner: `apps/worker/scripts/db-migrate.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` loaded by the worker migration runner from `.env.local` or `.env`.
- Produces: `workflow_runs.prompt_manifest jsonb` in the local database used by the running worker.

- [ ] **Step 1: Confirm the migration is pending from the observed failure**

Record the reproduction: `GET /api/v1/runs/block-statuses` fails with PostgreSQL SQLSTATE `42703` and `column "prompt_manifest" does not exist` while `apps/worker/src/db/schema.ts` selects that column.

- [ ] **Step 2: Run the standard migration command**

Run:

```bash
pnpm --filter worker db:migrate
```

Expected: Drizzle applies `0021_flippant_justice.sql` and the environment marker check ends with an `OK` message. If `DATABASE_URL` is absent, stop and report that the runner skipped instead of claiming the database is fixed.

- [ ] **Step 3: Re-run the failing request**

Refresh the editor page that polls `/api/v1/runs/block-statuses`.

Expected: no SQLSTATE `42703`, no missing-column stack trace, and the endpoint returns its normal authenticated response.

---

### Task 2: Share the first-party default prompt mapping

**Files:**
- Create: `apps/shared/contracts/default-agent-prompt-references.ts`
- Modify: `apps/shared/contracts/index.ts`
- Test: `apps/shared/contracts/default-agent-prompt-references.test.ts`

**Interfaces:**
- Produces: `DEFAULT_PROMPT_NAME_BY_AGENT`, a partial record mapping `planning_agent`, `implementation_agent`, and `review_agent` to keys of `DEFAULT_AGENT_PROMPTS`.
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Write the failing mapping test**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_NAME_BY_AGENT } from "./default-agent-prompt-references.js";

describe("DEFAULT_PROMPT_NAME_BY_AGENT", () => {
  it("maps only first-party default agents to their versioned library prompts", () => {
    expect(DEFAULT_PROMPT_NAME_BY_AGENT).toEqual({
      planning_agent: "research-plan",
      implementation_agent: "implement",
      review_agent: "review",
    });
    expect(DEFAULT_PROMPT_NAME_BY_AGENT.generic_agent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --filter worker exec vitest run ../shared/contracts/default-agent-prompt-references.test.ts
```

Expected: FAIL because the module/export does not exist.

- [ ] **Step 3: Add the minimal shared mapping**

```ts
import type { WorkflowBlockType } from "./domain.js";
import type { DEFAULT_AGENT_PROMPTS } from "./default-prompts.js";

export const DEFAULT_PROMPT_NAME_BY_AGENT = {
  planning_agent: "research-plan",
  implementation_agent: "implement",
  review_agent: "review",
} as const satisfies Partial<Record<WorkflowBlockType, keyof typeof DEFAULT_AGENT_PROMPTS>>;
```

Export the module from `apps/shared/contracts/index.ts`.

- [ ] **Step 4: Run the focused test and shared build**

```bash
pnpm --filter worker exec vitest run ../shared/contracts/default-agent-prompt-references.test.ts
pnpm --filter @shared/contracts build
```

Expected: PASS and TypeScript build exits 0.

- [ ] **Step 5: Commit the shared contract**

```bash
git add apps/shared/contracts/default-agent-prompt-references.ts apps/shared/contracts/default-agent-prompt-references.test.ts apps/shared/contracts/index.ts
git commit -m "feat(shared): map agent default prompts"
```

---

### Task 3: Resolve implicit defaults as live references per run

**Files:**
- Modify: `apps/worker/src/workflows/prompt-references-step.ts`
- Modify: `apps/worker/src/workflows/prompt-references-step.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_NAME_BY_AGENT`, `listPrompts(db, { includeArchived: true })`, and the existing `resolvePromptReferencesInNodes` loader contract.
- Produces: `materializeImplicitDefaultPromptReferences(nodes, promptRows): WorkflowDefinitionNode[]`, where rows expose `id`, `name`, and `archivedAt`.
- Behavior: blank mapped-agent prompts become `{{prompt:<id>}}` before recursive expansion; nonblank prompts and unmapped blocks are unchanged.

- [ ] **Step 1: Write failing pure-function tests**

Add tests that assert:

```ts
const nodes = [
  node("planning_agent", {}),
  node("implementation_agent", { prompt: "   " }),
  node("review_agent", { prompt: "custom" }),
  node("generic_agent", { prompt: "generic" }),
];
const result = materializeImplicitDefaultPromptReferences(nodes, [
  { id: 11, name: "research-plan", archivedAt: null },
  { id: 12, name: "implement", archivedAt: null },
  { id: 13, name: "review", archivedAt: null },
]);

expect(result[0].params.prompt).toBe("{{prompt:11}}");
expect(result[1].params.prompt).toBe("{{prompt:12}}");
expect(result[2]).toBe(nodes[2]);
expect(result[3]).toBe(nodes[3]);
expect(nodes[0].params.prompt).toBeUndefined();
```

Add separate cases asserting that a required missing name throws `Default prompt "research-plan" is missing` and an archived default throws `Default prompt "research-plan" is archived` through the database-facing preparation helper.

- [ ] **Step 2: Run the focused worker test and verify RED**

```bash
pnpm --filter worker exec vitest run src/workflows/prompt-references-step.test.ts
```

Expected: FAIL because implicit materialization is not implemented.

- [ ] **Step 3: Implement minimal materialization**

Add a pure exported function that clones only changed nodes:

```ts
export function materializeImplicitDefaultPromptReferences(
  nodes: readonly WorkflowDefinitionNode[],
  promptRows: readonly Pick<PromptLibraryListRow, "id" | "name" | "archivedAt">[],
): WorkflowDefinitionNode[] {
  return nodes.map((node) => {
    const name = DEFAULT_PROMPT_NAME_BY_AGENT[node.type];
    if (!name) return node;
    const current = node.params.prompt;
    if (typeof current === "string" && current.trim().length > 0) return node;
    const row = promptRows.find((candidate) => candidate.name === name);
    if (!row) throw new Error(`Default prompt "${name}" is missing`);
    if (row.archivedAt !== null) throw new Error(`Default prompt "${name}" is archived`);
    return {
      ...node,
      params: {
        ...node.params,
        prompt: formatPromptReferenceToken({ promptId: row.id, version: "latest" }),
      },
    };
  });
}
```

In `resolvePromptReferencesForRun`, detect which mapped defaults are required, load prompt-library rows once with archived rows included, reject an archived required row, materialize the implicit tokens, then pass those nodes into `resolvePromptReferencesInNodes`. Keep the existing latest loader as the authority that freezes the current version and builds the manifest.

- [ ] **Step 4: Verify recursive expansion and manifest behavior**

Extend the integration-style step test so an omitted planning prompt resolves to the library body, nested references expand, `{{ticket_key}}` remains for the later global pass, and the manifest contains the implicit `latest` entry.

Run:

```bash
pnpm --filter worker exec vitest run src/workflows/prompt-references.test.ts src/workflows/prompt-references-step.test.ts
pnpm --filter worker typecheck
```

Expected: all focused tests pass and typecheck exits 0.

- [ ] **Step 5: Commit worker behavior**

```bash
git add apps/worker/src/workflows/prompt-references-step.ts apps/worker/src/workflows/prompt-references-step.test.ts
git commit -m "feat(worker): resolve implicit default prompt references"
```

---

### Task 4: Derive the effective default reference in the inspector

**Files:**
- Create: `apps/dashboard/lib/prompt-library/effective-default.ts`
- Create: `apps/dashboard/lib/prompt-library/effective-default.test.ts`
- Modify: `apps/dashboard/components/cockpit/flow-editor/config-fields.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_NAME_BY_AGENT` and prompt-library list rows.
- Produces: `effectiveDefaultPromptValue(value, promptName, rows): { value: string; implicit: boolean }`.
- Consumed by: `PromptField` textarea metadata, reference chips, and expanded modal.

- [ ] **Step 1: Write the failing effective-value tests**

Cover these cases with minimal `PromptLibraryListRowDto` fixtures:

```ts
assert.deepEqual(effectiveDefaultPromptValue("", "research-plan", [activeRow]), {
  value: "{{prompt:7}}",
  implicit: true,
});
assert.deepEqual(effectiveDefaultPromptValue("local", "research-plan", [activeRow]), {
  value: "local",
  implicit: false,
});
assert.deepEqual(effectiveDefaultPromptValue("", "missing", [activeRow]), {
  value: "",
  implicit: true,
});
```

Also assert archived rows are not materialized as effective tokens.

- [ ] **Step 2: Run the dashboard test and verify RED**

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test apps/dashboard/lib/prompt-library/effective-default.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the pure helper**

```ts
export function effectiveDefaultPromptValue(
  value: string,
  promptName: string | undefined,
  rows: readonly PromptLibraryListRowDto[],
): { value: string; implicit: boolean } {
  if (value.trim().length > 0 || !promptName) return { value, implicit: false };
  const row = rows.find((candidate) => candidate.name === promptName && candidate.archivedAt === null);
  return {
    value: row ? formatPromptReferenceToken({ promptId: row.id, version: "latest" }) : "",
    implicit: true,
  };
}
```

- [ ] **Step 4: Replace built-in-template presentation**

In `config-fields.tsx`, replace `placeholder`, `helper`, and `builtInTemplate` wiring with `defaultPromptName={DEFAULT_PROMPT_NAME_BY_AGENT[node.type]}`.

In `PromptField`:

- keep the textarea controlled by the stored raw value so opening the screen does not dirty the workflow;
- render `PromptReferenceChips` from the effective value;
- pass the effective value to `PromptEditorModal`;
- route chip/modal edits through `setBodyValue`, making the reference explicit only after an action;
- show `Default prompt · Latest` while the library is loading/unavailable;
- remove `TemplateModal`, `templateOpen`, `builtInTemplate`, `View built-in template`, and hidden-fallback helper copy.

Clearing explicit/local content must leave the stored value empty and immediately restore the derived implicit chip.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test apps/dashboard/lib/prompt-library/effective-default.test.ts
pnpm --filter ai-workflow-dashboard typecheck
```

Expected: tests pass and typecheck exits 0.

- [ ] **Step 6: Commit inspector behavior**

Stage only the files from this task and commit without absorbing unrelated dirty files:

```bash
git add apps/dashboard/lib/prompt-library/effective-default.ts apps/dashboard/lib/prompt-library/effective-default.test.ts apps/dashboard/components/cockpit/flow-editor/config-fields.tsx apps/dashboard/components/cockpit/flow-editor/prompt-field.tsx
git commit -m "feat(studio): show implicit live prompt defaults"
```

---

### Task 5: Open the library by default and add an editable new section

**Files:**
- Modify: `apps/dashboard/lib/prompt-library/composer.ts`
- Modify: `apps/dashboard/lib/prompt-library/composer.test.ts`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx`
- Modify: `apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx`
- Modify: `apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx`

**Interfaces:**
- Produces: `appendComposerSection(blocks, makeId): { blocks: ComposerBlock[]; sectionId: string }`.
- Extends: `PromptEditorProps` with `autoFocus?: boolean`.
- Preserves: existing drag payloads, exact drop indices, serialization, and Raw mode.

- [ ] **Step 1: Write the failing composer test**

```ts
test("appends a writable section and returns its stable id", () => {
  const blocks = parseComposerBlocks("{{prompt:7}}", ids());
  const result = appendComposerSection(blocks, ids());
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[1].kind, "section");
  assert.equal(result.blocks[1].body, "## New section");
  assert.equal(result.sectionId, result.blocks[1].id);
  assert.equal(serializeComposerBlocks(result.blocks), "{{prompt:7}}\n\n## New section");
});
```

- [ ] **Step 2: Run the composer test and verify RED**

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test apps/dashboard/lib/prompt-library/composer.test.ts
```

Expected: FAIL because `appendComposerSection` is not exported.

- [ ] **Step 3: Add the minimal append helper**

```ts
export function appendComposerSection(
  blocks: readonly ComposerBlock[],
  makeId: ComposerIdFactory,
): { blocks: ComposerBlock[]; sectionId: string } {
  const sectionId = makeId();
  const section: ComposerSectionBlock = {
    id: sectionId,
    kind: "section",
    title: "New section",
    level: 2,
    body: "## New section",
  };
  return { blocks: [...blocks, section], sectionId };
}
```

- [ ] **Step 4: Wire the Visual-mode action and focus**

Add `+ New section` next to the Raw toggle. On click:

1. call `appendComposerSection`;
2. commit the returned blocks;
3. set `activeId` to `sectionId`;
4. request-animation-frame scroll the card into view;
5. render the active section's `PromptEditor` with `autoFocus`.

Extend `PromptEditorProps` with `autoFocus?: boolean` and focus the Tiptap editor at the end once it is created:

```ts
useEffect(() => {
  if (!editor || !autoFocus) return;
  const frame = requestAnimationFrame(() => editor.commands.focus("end"));
  return () => cancelAnimationFrame(frame);
}, [autoFocus, editor]);
```

Change the empty-state copy to mention `New section` instead of instructing users to switch to Raw.

- [ ] **Step 5: Make the library rail open on every modal open**

Initialize `libOpen` to `true` and add:

```ts
useEffect(() => {
  if (open) setLibOpen(true);
}, [open]);
```

This resets a manually closed rail only on the next modal open and does not interfere while the modal stays open.

- [ ] **Step 6: Run focused and dashboard verification**

```bash
pnpm --filter ai-workflow-dashboard exec tsx --test apps/dashboard/lib/prompt-library/composer.test.ts apps/dashboard/lib/prompt-library/effective-default.test.ts
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
```

Expected: focused tests pass, typecheck passes, and the production build completes.

- [ ] **Step 7: Commit composer UX**

```bash
git add apps/dashboard/lib/prompt-library/composer.ts apps/dashboard/lib/prompt-library/composer.test.ts apps/dashboard/components/cockpit/prompt-editor/prompt-editor.tsx apps/dashboard/components/cockpit/prompt-editor/prompt-section-composer.tsx apps/dashboard/components/cockpit/flow-editor/prompt-editor-modal.tsx
git commit -m "feat(studio): add visual prompt sections"
```

---

### Task 6: Full verification and review

**Files:**
- Review all files changed by Tasks 2–5.

**Interfaces:**
- Verifies the complete path: workflow editor → explicit/implicit reference → run-start resolution → manifest persistence.

- [ ] **Step 1: Run all automated checks**

```bash
pnpm --filter ai-workflow-dashboard test
pnpm --filter ai-workflow-dashboard typecheck
pnpm --filter ai-workflow-dashboard build
pnpm --filter worker test
pnpm --filter worker typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Perform the UX smoke test**

Verify in `/editor`:

1. select a planning agent with an omitted prompt;
2. confirm the inspector shows `research-plan · Latest · vN` and no `View built-in template`;
3. expand the editor and confirm the library is open and the effective live-reference card is visible;
4. close the library, close the modal, reopen it, and confirm the library opens again;
5. click `+ New section`, type immediately, and confirm the new card remains after closing/reopening;
6. drag a library section between cards and confirm exact placement;
7. clear local content and confirm the implicit default reference returns;
8. trigger the block-status poll and confirm no `prompt_manifest` missing-column error.

- [ ] **Step 3: Review data and failure semantics**

Confirm from code and tests that:

- opening the modal alone does not persist a token or dirty the workflow;
- an implicit latest default is frozen once per run and appears in `prompt_manifest`;
- missing/archived built-in prompts fail clearly;
- pinned explicit archived versions still resolve;
- generic agents do not receive a default;
- no existing unrelated dirty files were staged or rewritten.

- [ ] **Step 4: Fix review findings test-first and rerun affected checks**

For each concrete finding, add the smallest reproducing test, verify it fails, apply the minimal fix, and rerun the focused suite before the full relevant suite.
