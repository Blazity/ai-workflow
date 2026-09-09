# Prompt Reference Sidebar Simplification Design

## Goal

Remove the duplicated live-reference card from the compact prompt inspector and make the primary reference actions easier to discover in the full prompt editor.

## Approved UX

The compact inspector shows one prompt summary only. `PromptInspectorCard` remains the source of the prompt name, current version, structural summary, and the `Edit prompt` entry point. It must not render `PromptReferenceChips` below that summary, including for the implicit default prompt.

The full prompt editor remains the place where a live reference is displayed in context with the rest of the composed prompt. Its reference card keeps the read-only content expansion and library navigation.

For editable prompts, the reference card action row contains these primary actions:

- `Show content` / `Hide content`
- `Open in library`
- `Detach and edit`

`Detach and edit` expands the referenced content into editable prompt text using the existing detach behavior. Its busy state remains `Detaching…` and repeated activation is disabled while the operation is running.

The overflow menu remains for the less frequent version-management action only:

- latest references offer `Pin vN`
- pinned references offer `Follow latest`

Read-only surfaces continue to hide mutation actions, including detach and version management, while retaining content expansion and library navigation.

## Scope Boundaries

- Do not change reference resolution, version pinning, detachment semantics, or the prompt editor data model.
- Do not remove provenance information for copied or detached prompts; provenance is not a live reference and communicates different state.
- Do not change the automatic left-rail selection or prompt-library deep links.
- Do not redesign adjacent inspector controls.
- Do not add dependencies.

## Responsive Behavior

The full editor action row may wrap on narrow widths. Each action remains readable and independently clickable. The overflow trigger stays aligned with the primary actions and retains its existing accessible label and focus behavior.

## Verification

Automated coverage must prove that:

- editable live-reference cards expose `Detach and edit` directly;
- read-only cards do not expose detach or version-management controls;
- the compact `PromptField` no longer renders `PromptReferenceChips`;
- the existing prompt-editor tests, dashboard typecheck, and production build pass.

A final code and UI review must confirm that the sidebar contains no duplicate live-reference block and that only the approved action hierarchy changed.
