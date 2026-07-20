# Prompt section composer

## Goal

Turn the expanded prompt editor into a clear section composer. Users can drag a whole library prompt or one of its sections into an exact position in the current prompt, then reorder the current prompt's sections without losing the existing markdown format, editor focus, or scroll position.

## Chosen direction

Use distinct section cards on the right side of the modal. Markdown remains the single persisted value and source of truth; the card layout is a structured editing view derived from that markdown. This avoids a prompt-data migration and keeps Visual and Raw modes interoperable.

The alternatives were rejected for this iteration:

- A separate JSON section model would require migration and ongoing synchronization with markdown.
- Dragging Tiptap document nodes directly would retain a continuous-document appearance, but would make section boundaries and drop targets less legible and couple the interaction to editor internals.

## Section model

`splitSections` defines the same section boundaries for the library and composer across H1, H2, and H3 headings. Each section retains its full markdown body, including its heading and content. Reordering or inserting sections reconstructs the prompt by joining those complete bodies with the canonical separator used by the existing prompt insertion helpers.

Duplicate section titles are valid. A drop always inserts new content; it does not merge, deduplicate, or replace a section based on its title. Within a single rendered prompt, cards use stable view identities derived for the current parse so equal titles and equal bodies remain independently movable.

Content before the first markdown heading must remain editable and movable rather than being discarded. It is represented as an untitled introductory card. A prompt with no headings is represented as one untitled card. Fenced code containing heading-like text continues to be handled by `splitSections` and must not create false cards.

## Layout and interaction

The modal retains its current two-panel proportions. The left rail keeps search, filtering, prompt selection, version selection, variables, and the existing whole-prompt actions. Its preview changes from a continuous preview into compact source-section rows with a dedicated drag handle. The whole selected prompt also receives a drag handle.

The right pane contains a pinned formatting toolbar followed by a vertically scrollable stack of editable section cards. The toolbar always targets the editor in the currently focused card and becomes inactive when no card editor is selected. Each card contains:

- a drag handle with an accessible name;
- the existing rich-text editing surface for that section's markdown;
- a compact actions menu with `Move up`, `Move down`, and section removal;
- a visible selected/focused state that does not rely on focus being moved to an unrelated button.

Dragging a library section inserts one copied card. Dragging the whole library prompt inserts all of its sections as one ordered block. In both cases, the insertion happens at the exact drop target between right-side cards. Existing same-named sections remain unchanged.

Dragging a card within the right pane reorders it. While dragging, the source retains a lightweight placeholder so the list does not jump. Only one insertion line is shown at a time, with sufficient contrast and a short label for a whole-prompt block where useful. The composer auto-scrolls near its top and bottom edges, but completing a drop does not scroll to the start of the prompt. Focus moves to the inserted or moved card only when that gives the user a useful continuation point; it never lands on an arbitrary toolbar or modal control.

Pointer drag is not the only way to reorder. The card actions menu provides `Move up` and `Move down`, with disabled states at the list boundaries. Library content keeps its existing click actions, so users can still use `Replace all`, `Add to end`, and the per-section insert action without dragging.

## Editing and markdown synchronization

Visual mode edits the parsed section collection, but emits a single joined markdown string through the existing `onChange` contract. A content edit updates only its card body. A reorder or external drop updates the section order and emits once after the operation completes.

The implementation must not recreate the entire editor tree on every keystroke. Stable card identities preserve the active section editor, selection, and composition state while its content changes. Parent value updates that already equal the joined local markdown are ignored, following the existing controlled-editor guard.

Raw mode remains a single full-width markdown textarea. Switching from Visual to Raw serializes the current card order. Switching back reparses the raw markdown into cards and preserves the current scroll position as closely as practical. If Raw mode changes section boundaries, the newly parsed boundaries become authoritative.

Library insertion and replacement requests remain explicit rather than inferred from normalized markdown. `Replace all` replaces the complete card collection and positions the composer at the beginning. `Add to end` appends the selected prompt as a block and reveals the first newly added card near the bottom. An exact-position drag reveals the drop location without resetting either pane to the top.

## Drag-and-drop behavior

Use one shared drag payload contract with three source kinds:

- `library-section`: full markdown for one section;
- `library-prompt`: the ordered full markdown bodies of all parsed sections;
- `composer-section`: the stable identity of one current card.

The right pane exposes insertion targets before the first card, between every pair, and after the final card. Empty prompts expose one full-width drop target. Drops outside a valid target make no change. Escape cancels an active drag. Any drag library chosen during implementation must support pointer and keyboard sensors without changing the persisted prompt schema.

## Visual design

Cards use the existing neutral surfaces, compact radius, and mariner focus color rather than introducing a new visual language. Spacing between cards should communicate grouping without resembling an extra blank markdown line. Handles and secondary actions stay quiet until hover or focus, while section titles and editable content remain readable at rest.

The dragged preview is smaller and slightly elevated, not a full opaque clone of a long section. Motion uses the project's short standard easing, respects reduced-motion preferences, and avoids scale effects that make text visibly blur. The left source row and right drop target both indicate the active operation so the origin and destination are easy to track.

## Error and edge behavior

- Empty library prompts cannot start a drag and retain the existing empty-state messaging.
- A failed or cancelled drag leaves markdown, focus, and scroll unchanged.
- Very long sections remain internally editable; the composer owns vertical scrolling so cards do not create nested vertical scroll regions.
- Duplicate headings, heading level differences, variables, code blocks, lists, and inline formatting round-trip as markdown.
- When external data replaces the prompt while no local drag is active, the composer reparses it. An external update must not interrupt an active pointer operation mid-frame.

## Verification

- Unit tests cover inserting one section at the start, middle, and end; inserting a whole prompt as an ordered block; reordering; duplicates; intro content; no-heading prompts; and fenced heading-like code.
- Component tests verify drag payloads and keyboard `Move up`/`Move down` actions produce the expected markdown.
- Regression tests verify typing keeps focus and selection, a drop does not scroll to the top, cancellation changes nothing, and switching Raw → Visual rebuilds the expected cards.
- Browser verification covers pointer dragging from both left-side source kinds, right-side reordering, edge auto-scroll, empty prompt drops, keyboard reordering, and reduced motion.
- Run the dashboard test suite, type checking, production build, and diff checks before completion.

## Non-goals

- No prompt storage migration or persisted JSON section schema.
- No automatic merging, deduplication, or title-based replacement.
- No nested subsection tree; every H1, H2, or H3 boundary returned by `splitSections` remains a flat card in this iteration.
- No redesign of prompt search, version selection, variables, or the base inspector textarea outside the expanded modal.
- No removal of the existing click-based insertion actions.
