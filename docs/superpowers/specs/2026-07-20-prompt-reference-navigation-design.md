# Prompt Reference Navigation Design

## Goal

Make prompt references understandable and directly navigable without rendering raw Markdown in the narrow workflow inspector.

## Workflow Inspector

- The entire prompt summary card is an obvious dialog trigger with `cursor-pointer`, a stronger hover border/background, visible keyboard focus, and a trailing chevron.
- The inspector never displays raw prompt Markdown.
- A custom prompt summary shows structural metadata: section count, live-reference count, character count, and up to three section names.
- Section names are extracted from the same composer parsing model used by the modal so the summary matches the visible editor structure.
- More than three sections are represented by a compact `+N more` label.
- A prompt containing references shows their library names as compact linked-prompt rows below the summary, not as raw `{{prompt:id}}` tokens.
- The primary card action remains `Edit prompt` for editable workflows and `View prompt` for read-only workflows.

## Reference Card in the Modal

- A reference block renders as a compact card with prompt name, selector state (`Latest · vN` or `Pinned vN`), and explicit `Preview` and `Open in library` actions.
- `Pin`, `Follow latest`, and `Detach` remain available but move into a compact overflow menu to reduce visual noise.
- The explanatory sentence below the reference is removed; the selector status and action labels carry the meaning, with concise tooltips where needed.
- Missing references retain a warning state and do not expose navigation actions that cannot resolve a target.

## Synchronized Preview

- Clicking `Preview` opens the modal library rail if it is closed.
- The rail selects the referenced prompt, selects the referenced pinned version or the current version for `Latest`, and scrolls the prompt preview to the top.
- Selecting a reference for preview does not mutate the workflow prompt.
- In read-only mode, synchronized preview remains available because it is navigation, not mutation.
- If prompt detail or a pinned version cannot be loaded, the rail keeps the prompt selected and shows its existing unavailable-version/error state without changing the workflow.

## Prompt Library Link

- `Open in library` opens the dashboard Prompts page in a new tab with the prompt id encoded in the query string: `/prompts?prompt=<id>`.
- The Prompts page reads the query parameter and selects that prompt when it exists.
- If the id is missing, archived outside the current view, or invalid, the page falls back to its normal initial selection without an error page.
- External-tab semantics are visible through the `↗` icon and accessible link label.

## Accessibility and Interaction

- Card and reference actions use native buttons or links and support keyboard activation.
- Hover-only affordances remain visible on keyboard focus.
- The overflow menu is keyboard navigable and closes on Escape or outside click.
- `Preview` preserves focus inside the existing modal; `Open in library` does not close or mutate the modal.
- Read-only mode hides mutation actions but keeps `Preview` and `Open in library` enabled.

## Verification

- Unit tests cover structural inspector summaries for plain, referenced, and more-than-three-section prompts.
- Component/contract tests cover pointer/focus affordances, Preview availability, mutation-action visibility, and the library link.
- State tests cover preview selection for latest, pinned, missing prompt, and missing version.
- Prompts-page tests cover valid and invalid `prompt` query parameters.
- Dashboard tests, typecheck, production build, and `git diff --check` pass.
- Manual browser verification covers the workflow inspector, modal Preview synchronization, overflow menu, deep link, and read-only behavior.
