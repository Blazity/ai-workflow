# Default Live Prompt UX

## Goal

Replace the hidden in-code default-template behavior for planning, implementation, and review agents with an explicit, visible live-reference experience. Existing workflow definitions that omit the prompt must remain compatible.

## Current Problems

- The dashboard describes an empty prompt as a built-in template and exposes a separate read-only preview.
- The runtime uses an in-code fallback when the prompt is absent, even though the same built-in prompt exists in the versioned prompt library.
- A user cannot see whether the default will follow future prompt versions.
- The expanded composer requires Raw mode to start a brand-new section.
- The library rail is closed when the expanded editor opens, hiding the primary composition workflow.
- The local database can lag behind the application schema, as shown by the missing `workflow_runs.prompt_manifest` column.

## Effective Default Reference

The three first-party agent types map to prompt-library names:

| Agent type | Default prompt name |
| --- | --- |
| `planning_agent` | `research-plan` |
| `implementation_agent` | `implement` |
| `review_agent` | `review` |

When the relevant prompt parameter is absent or blank, it has the same runtime meaning as a `Latest` reference to the mapped library prompt. This is an implicit default reference: old workflow versions remain byte-compatible and do not need a data migration.

At run start, the worker resolves the implicit reference from the prompt library, freezes the selected version for that run, recursively expands nested prompt references, and records the same manifest entry as it would for an explicit `{{prompt:<id>}}` token. Global ticket variables are substituted afterwards by the existing pass.

If the mapped library prompt is missing or archived, the run fails with a precise configuration error rather than silently falling back to a different in-code body. Pinned explicit references retain their existing archived-version behavior.

## Inspector UX

For an empty default-agent prompt, the field displays an effective live-reference chip such as `research-plan · Latest · v3`. The empty textarea no longer presents a hidden-template placeholder or helper copy.

The separate `View built-in template` action and its preview modal are removed. The prompt library and expanded composer become the single place for inspecting and composing prompt content.

Typing into the inspector replaces the implicit reference with local text. Selecting or dragging a prompt from the library stores the existing explicit latest or pinned reference token. Clearing local text restores the implicit default reference.

If the prompt library is temporarily unavailable, the inspector shows a neutral `Default prompt · Latest` state and preserves editing; it does not fabricate a resolved version.

## Expanded Composer UX

- The library rail opens by default every time the expanded modal opens.
- An empty default-agent prompt is presented as one live-reference card for the effective default prompt.
- The composer header includes `+ New section` in Visual mode.
- `+ New section` appends a markdown heading block, scrolls it into view, activates its existing rich-text editor, and moves focus into it.
- Users can type and format the new section normally without switching to Raw.
- Raw remains an escape hatch for whole-document markdown editing.
- Existing exact-position drag-and-drop and card reordering behavior remains unchanged.

The implicit default reference is not persisted merely by opening the modal. It becomes explicit only when the user performs an edit that changes the composed value. This avoids dirtying a workflow through inspection alone.

## Database Migration

The existing `0021_flippant_justice.sql` migration adds `workflow_runs.prompt_manifest`. Local development must apply it through the worker's standard `db:migrate` command against the same `DATABASE_URL` used by the running services. No fallback query or conditional column selection will be added, because that would hide schema drift.

## Verification

- A database schema check confirms `prompt_manifest` exists after migration and the block-status endpoint succeeds.
- Worker tests cover implicit default resolution, latest-version freezing, missing/archived defaults, recursive references, and manifest persistence.
- Dashboard tests cover effective default display, explicit editing semantics, modal default-open state, and new-section insertion.
- Existing prompt-reference, composer, dashboard, and worker suites remain green.
- Dashboard typecheck and production build pass.

## Out of Scope

- Rewriting historical workflow-definition versions to contain explicit reference tokens.
- Adding a second built-in-template preview surface.
- Changing the behavior of generic agents or arbitrary prompt-bearing fields that have no named first-party default.
