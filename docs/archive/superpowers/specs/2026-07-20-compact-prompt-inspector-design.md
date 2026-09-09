# Compact Prompt Inspector Design

## Goal

Make the workflow inspector a compact summary of prompt configuration and keep the prompt editor modal as the single place for reading and editing full prompt content.

## Inspector UX

- Remove the inline prompt textarea from every `PromptField` usage.
- Remove the separate `Library` action because the library is already open by default inside the editor modal.
- Show one compact, clickable prompt card in its place.
- The card contains the effective prompt name and version state (`Latest` or pinned version) when the field uses a library reference.
- For custom prompt text, the card shows a maximum two-line preview and the existing character/token estimate.
- For an empty field without an implicit default, the card shows a neutral `No prompt configured` state.
- The primary action is `Edit prompt`. Clicking either the action or the card opens the same modal.
- In a non-editable workflow, the action reads `View prompt`; the modal opens in read-only mode.

## Editing and Data Behavior

- The modal remains the only full prompt editing surface.
- Existing default-live-reference behavior remains unchanged: opening the modal does not persist or detach the implicit reference.
- Existing latest/pinned reference controls and provenance remain visible in the compact card or modal as appropriate.
- Saving changes from the modal continues to write through the existing `PromptField` change callback.
- Removing the textarea must not change stored workflow data, prompt reference resolution, or run-time behavior.

## Components

- `PromptField` owns the compact summary card, modal open state, reference status, and existing insert/save behavior needed by the modal.
- `PromptEditorModal` accepts a read-only state so configured prompts can still be inspected when workflow editing is disabled.
- Existing library, composer, reference chip, and variable UI inside the modal remain unchanged.

## Accessibility

- The card is keyboard reachable and exposes dialog semantics through its accessible label.
- `Enter` and `Space` open the modal.
- Disabled workflows do not disable viewing; they disable only mutation controls inside the modal.
- The summary preview is supplementary and is not the only indication of reference state.

## Verification

- Component tests cover implicit default, pinned/latest reference, custom preview, empty state, and read-only opening.
- Existing prompt reference and composer tests continue to pass.
- Dashboard typecheck and production build pass.
- Manual verification confirms that no small textarea or duplicate Library action remains in the inspector and that the modal is the sole editor.
