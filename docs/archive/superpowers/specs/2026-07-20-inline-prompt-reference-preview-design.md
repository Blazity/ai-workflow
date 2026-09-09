# Inline Prompt Reference Preview Design

## Goal

Make live prompt references readable in context. A reference stays a live, non-editable token by default, but the user can expand its resolved content directly where the reference appears without navigating to the library rail.

## Interaction model

- Every resolved reference renders as a full-width responsive card, not a single crowded chip.
- The header contains the prompt name, a `Live reference` badge, the selector (`Latest` or `Pinned`), and the resolved version.
- `Show content` expands the complete referenced prompt inline. `Hide content` collapses it.
- Multiple references can remain expanded simultaneously so the complete composed prompt can be read from top to bottom.
- Expanded content is rendered with the existing Markdown preview and is explicitly labelled `Referenced content · read-only`.
- `Open in library ↗` remains a direct link for prompt management.
- `Pin vN` / `Follow latest` and `Detach and edit` live in the `···` menu. Detaching replaces the token with the exact referenced body and makes the result local/editable through the existing composer behavior.
- Missing prompts expose no navigation or mutation actions. Missing pinned versions show an explicit unavailable state.

## Layout and visual treatment

- The card uses a vertical shell with a metadata row and an action row that can wrap cleanly at inspector width.
- Badges and controls use fixed heights, tabular version numbers, aligned baselines, and non-overlapping hit areas.
- The expanded body uses a subtle mariner-tinted surface and left accent to communicate that it is live, read-only content rather than a local editable section.
- The mutation menu renders in a body portal with fixed positioning. It must not be clipped by the composer's `overflow-hidden` article.
- Menu open/close uses an interruptible opacity/scale transition, closes on outside pointer-down and Escape, and returns focus to its trigger.

## Data flow

- Latest references and pinned references to the current version use the list row body immediately.
- Pinned historical versions lazy-load `/api/prompt-library/:id` only when expanded or detached.
- A small pure resolver maps a reference, list row, and optional detail response to `ready`, `needs-detail`, or `missing-version`; expansion and detach share this rule.
- Inline expansion is local presentation state and never calls the workflow `onChange` callback.
- Pin, Follow latest, and Detach remain the only reference-card actions that mutate workflow content.
- Opening the full prompt editor for a single-reference value still initializes the left rail to that reference, but inline `Show content` no longer drives rail navigation.

## Verification

- Pure tests cover latest, current pinned, historical pinned, and missing historical version resolution.
- SSR component tests cover the responsive card, aligned badges, `Show content`, library link, read-only mutation hiding, and missing-reference behavior.
- Contract tests ensure inline expansion has no workflow mutation capability.
- Dashboard tests, TypeScript checking, and the production build must pass.

## Out of scope

- Changing worker/runtime prompt resolution.
- Making referenced content editable before detaching.
- Adding dependencies or a second Markdown renderer.
