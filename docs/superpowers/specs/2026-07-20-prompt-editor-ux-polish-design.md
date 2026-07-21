# Prompt editor UX polish

## Goal

Make the expanded prompt editor easier to read and edit without changing its existing two-panel information architecture.

## Scope

- Increase the expanded editor modal to 94 vw, capped at 1240 px, and a maximum height of 90 vh.
- Preserve the current relative proportions of the library rail and editor area.
- Ensure the editor pane and both editing modes fill all remaining width and height without intrinsic-content overflow.
- Use one compact, readable markdown rhythm in the library preview, built-in template preview, and WYSIWYG editor.
- Keep keyboard focus inside the editor while typing and return it to the opener only when the modal actually closes.
- Expose a clear per-section append action on pointer hover and keyboard focus.

## Layout and visual design

The modal remains a centered, elevated two-panel dialog. It grows to `width: 94vw`, capped at `max-width: 1240px`, and `max-height: 90vh`, leaving a consistent viewport gutter on intermediate screens. The library rail retains its current width relationship to the editor. Every flex item in the horizontal editor layout may shrink below its intrinsic content width, while the editor root, toolbar, WYSIWYG surface, and Raw textarea occupy the full available width.

Markdown uses body text around 13 px with a comfortable line height. Headings are differentiated without dominating the rail: H1 is the strongest, H2 and H3 step down consistently. A heading receives more space before it than after it, paragraphs and lists keep a modest vertical rhythm, and the first and last blocks do not add artificial outer whitespace. The same rules apply to built-in template previews.

Each library section becomes a discrete hover/focus target. Its action is labelled `Append section` when the target already contains content and `Insert section` when it is empty. The control appears on `group-hover` and `group-focus-within`, remains keyboard reachable, and does not cover the section heading.

## Focus and data flow

Typing in Tiptap updates the controlled markdown value in the parent. That parent update must not restart the modal lifecycle effect. The modal close callback passed by `PromptField` therefore has a stable identity. Focus restoration remains in the modal cleanup and runs only after a real close or unmount.

External changes such as a library insert still synchronize into Tiptap with `setContent(..., emitUpdate: false)`. User typing does not trigger a second content replacement when the serialized markdown already equals the controlled value.

Raw mode uses the same flex container as WYSIWYG and swaps only the editing surface. The textarea fills the pane, scrolls internally, and never collapses to its intrinsic column width.

## Verification

- A regression test demonstrates that rerendering the field with a changed prompt value does not replace the modal close callback or restore focus.
- Markdown preview tests cover semantic block spacing/class selection where practical; layout behavior is verified in the browser at desktop and narrower viewport sizes.
- Manually type several characters in WYSIWYG and Raw modes and confirm focus and selection remain in the active editor.
- Open the library, hover and keyboard-focus multiple sections, then append one section and confirm only that section is added.
- Open the built-in template and confirm H1/H2/H3, paragraphs, lists, inline code, and code blocks have consistent spacing.
- Run dashboard tests and type checking.

## Non-goals

- No redesign of the library navigation or prompt data model.
- No new markdown features or dependencies.
- No change to the base inspector textarea outside the expanded modal.
- No unrelated refactoring or global typography changes.
