# Repository Scope Modal Design

## Goal

Make provider and repository scope configuration readable without expanding the
workflow editor or shifting the canvas when the repository picker opens.

The change is limited to the dashboard UI. Repository scope contracts,
validation rules, catalog loading, and workflow serialization remain unchanged.

## Collapsed State

Replace the current two-row repository/provider bar with one compact `Source
scope` row.

The row contains:

- an `Automatic` provider summary when no provider is pinned, otherwise one
  equal-height badge for each pinned provider;
- `Automatic per ticket` when no repository is pinned, otherwise a repository
  count such as `2 repositories`;
- a compact warning status when the saved scope contains a provider mismatch,
  an archived repository, or a repository missing from the settled catalog;
- one `Configure` button.

All summary badges use the same height, border radius, padding, and vertical
alignment. Dynamic counts use tabular numerals. The collapsed row never expands
to render the picker.

## Modal

`Configure` opens a centered modal over a fixed backdrop. The modal overlays the
editor and does not participate in document layout, so opening, filtering, and
closing it cannot move the workflow canvas.

The modal contains:

1. A header with `Configure source scope`, supporting copy, and a close button.
2. A `Providers` section with equal-size GitHub and GitLab toggle controls.
   Selecting neither means automatic provider resolution.
3. A `Repositories` section with selected repository chips, the existing
   catalog refresh action, search input, repository rows, remaining-slot count,
   and existing catalog fallback for exact manual entry.
4. Contextual warnings for provider mismatches, archived repositories, missing
   catalog entries, and catalog failures.
5. A sticky footer with `Cancel` and `Apply scope`.

The modal keeps a local draft of the entire `WorkflowRepositoryScope`. Provider
toggles, repository additions, and repository removals update only that draft.
`Apply scope` calls the existing `onChange` once with the complete draft and
closes the modal. `Cancel`, the close button, backdrop dismissal, and `Escape`
discard the draft.

Opening the modal always initializes a fresh draft from the current `scope`
prop. Read-only mode disables `Configure`, matching the current bar behavior.

## Interaction and Accessibility

- The modal uses accessible dialog semantics with an accessible title.
- Focus moves into the modal when it opens and returns to `Configure` when it
  closes.
- Focus stays within the modal while it is open.
- `Escape` and backdrop click cancel the draft.
- Buttons and row controls have at least a 40 by 40 pixel hit area.
- Visible keyboard focus is preserved for every interactive control.
- The modal body scrolls internally on short viewports; the workflow editor
  behind it remains fixed.
- On narrow screens the modal uses the available viewport width with safe outer
  spacing.

## Component Boundaries

Keep the change surgical:

- `RepositoryScopeBar` owns the compact summary and modal open state.
- `RepositoryScopeModal` owns the local draft and apply/cancel behavior.
- The existing picker catalog and manual-entry behavior are reused inside the
  modal rather than duplicated.
- Small presentational helpers may be introduced for consistent provider and
  repository badges.
- Domain helpers in `repository-scope.ts` remain the source of truth for scope
  mutations and validation descriptions.

## Verification

Update component and behavior tests to verify:

- the collapsed bar renders one compact source-scope row;
- the picker is absent from document flow until the modal is open;
- opening the modal does not mutate the supplied scope;
- cancel, close, backdrop click, and `Escape` discard draft changes;
- applying calls `onChange` once with provider and repository draft changes;
- provider toggles, repository filtering, multi-selection, removal, refresh,
  manual fallback, limits, and warnings retain their current behavior;
- read-only mode cannot open the modal;
- dialog naming and control labels remain accessible.

Run the focused repository-scope tests, dashboard type checking, and the
dashboard test suite before completion.
